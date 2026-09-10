/**
 * Sync DM (1-on-1) chatbot conversations into the CRM.
 *
 * The group pipeline keys everything off an @mention (R8); a DM has none — the
 * chat itself is the lead. The lead is created the moment someone writes, and
 * each message goes into the CRM's conversation view as it happens, so the team
 * can read a chat while it is still going.
 *
 * Messages go to POST /leads/{id}/messages, not to remarks. That endpoint is
 * what the CRM's inbox reads, and it takes one message at a time, so a chat
 * arrives as a conversation. The transcript used to be posted as a single
 * remark once a night, which put a wall of text where counsellors write notes
 * and left a morning enquiry invisible until 22:30.
 *
 * The daily job remains as a catch-up: anything that could not be sent live —
 * the CRM was down, the chat had no phone number yet — is picked up then.
 *
 * Follows the same rules as the rest of the CRM integration (docs/CRM-INTEGRATION.md):
 *   C1  notes only ever go through POST /leads/{id}/remarks, never lead.notes
 *   C5  a phone search returning more than one lead is ambiguous, never guessed
 *   C4  assigned_agent_id is deliberately omitted here (see below), not defaulted
 */
const repo = require('../db/repositories');
const logger = require('../logger');
const { DuplicateLeadError } = require('../crm/client');
const labelParser = require('./labels');

/**
 * Look across what the customer themselves wrote for an explicit "Name: X"
 * line. Same rule as R9 elsewhere in this codebase: a structured field is only
 * ever written from an explicit label, never guessed from free text.
 * @param {object[]} rows
 * @returns {string|null}
 */
function extractName(rows) {
  for (const row of rows) {
    if (row.direction !== 'in') continue;
    const { fields } = labelParser.parse(row.body);
    if (fields.full_name) return fields.full_name;
  }
  return null;
}

/**
 * Find or create the CRM lead for a DM chat, and remember it on the thread.
 *
 * Shared by two callers on purpose: the orchestrator calls it the moment someone
 * messages, and the nightly sync calls it for any thread that still has no lead
 * (because the CRM was down at the time, or the bot was restarting). One
 * implementation means the two can never drift into creating leads by different
 * rules.
 *
 * Safe to call repeatedly — a thread that already carries a lead id returns it
 * without touching the CRM.
 *
 * @param {import('../crm/client').CrmClient} crm
 * @param {object} thread - a dm_threads row
 * @param {string} [name] - a name discovered since the thread was written
 * @returns {Promise<{ status: 'ok'|'ambiguous'|'no_phone', leadId: string|null }>}
 * @throws on a CRM failure, so the caller can record it and retry later
 */
async function ensureCrmLead(crm, thread, name) {
  if (thread.crm_lead_id) return { status: 'ok', leadId: thread.crm_lead_id };

  // Without a number there is nothing to deduplicate against, and creating a
  // lead that can never be matched to anything is worse than waiting.
  if (!thread.phone) return { status: 'no_phone', leadId: null };

  const match = await crm.findByPhone(thread.phone);

  if (match.status === 'ambiguous') {
    // C5 — more than one lead shares this phone. Do not guess which one this
    // conversation belongs to; hold it for a human and try again next cycle,
    // by which time someone may have merged the records.
    repo.dmThreads.markAmbiguous(
      thread.chat_id, `${match.candidates} leads already share this phone`
    );
    return { status: 'ambiguous', leadId: null };
  }

  let leadId;

  if (match.status === 'found') {
    leadId = match.lead.id;
  } else {
    // The CRM requires a name; the phone is what actually identifies the lead.
    // Falling back to the number when nobody has given a name yet is the same
    // trade-off applied in the group pipeline.
    try {
      const { lead } = await crm.createLead({
        full_name: name || thread.name || thread.phone,
        phone: thread.phone
        // assigned_agent_id deliberately omitted — this thread has no employee
        // to attribute it to, and C4's auto-own risk only applies to a
        // manager-authenticated caller. This integration authenticates as an
        // admin (C6), so omitting it leaves the lead genuinely unassigned
        // rather than silently owned by anyone.
      });
      leadId = lead.id;
    } catch (error) {
      // B2 — findByPhone's substring search can miss a lead that a plain create
      // collides with anyway (e.g. it was added between our search and our
      // create). The duplicate error carries the real id, so recover instead of
      // failing the whole conversation.
      if (error instanceof DuplicateLeadError && error.existingLeadId) {
        leadId = error.existingLeadId;
      } else {
        throw error;
      }
    }
  }

  repo.dmThreads.setCrmLead(thread.chat_id, leadId);
  return { status: 'ok', leadId };
}

/**
 * Push a chat's un-sent messages into the CRM's conversation view.
 *
 * One row per message, so the CRM's inbox reads as a conversation rather than a
 * wall of text. Each is marked as it lands rather than at the end, so a failure
 * halfway through neither loses the ones already sent nor sends them twice —
 * and the endpoint is idempotent on wa_message_id anyway, so a retry after an
 * ambiguous failure is harmless.
 *
 * Safe to call at any time: called live as messages arrive, and again by the
 * daily job for anything that was missed while the CRM was unreachable.
 *
 * @param {import('../crm/client').CrmClient} crm
 * @param {object} thread - a dm_threads row, already carrying crm_lead_id
 * @returns {Promise<number>} how many messages were sent
 */
async function pushDmMessages(crm, thread) {
  if (!thread?.crm_lead_id) return 0;

  const rows = repo.dmMessages.unsyncedForChat(thread.chat_id);
  let sent = 0;

  for (const row of rows) {
    await crm.addLeadMessage(thread.crm_lead_id, {
      body: row.body,
      // Only the customer's number is meaningful here. Our own end of the
      // conversation is identified by is_our_team, not by a number.
      senderPhone: row.direction === 'in' ? thread.phone : undefined,
      senderName: row.direction === 'in' ? thread.name : undefined,
      isOurTeam: row.direction === 'out',
      waMessageId: row.wa_message_id,
      sentAt: row.created_at ? new Date(`${row.created_at.replace(' ', 'T')}Z`).toISOString()
        : undefined
    });

    repo.dmMessages.markSynced([row.id]);
    sent += 1;
  }

  return sent;
}

/**
 * Sync every DM chat that has unsynced messages.
 * @param {import('../crm/client').CrmClient} crm
 * @returns {Promise<{ synced: number, failed: number }>}
 */
async function syncDmConversations(crm) {
  if (!crm.configured) {
    logger.warn('CRM not configured — DM conversations are captured but not synced');
    return { synced: 0, failed: 0 };
  }

  const chatIds = repo.dmMessages.chatsWithUnsynced();
  let synced = 0;
  let failed = 0;

  for (const chatId of chatIds) {
    // The thread row is created at capture time (orchestrator.handleDirect), but
    // guard anyway rather than crash a whole run over one unexpected gap.
    const thread = repo.dmThreads.byChatId(chatId) || repo.dmThreads.upsert(chatId, null);
    const rows = repo.dmMessages.unsyncedForChat(chatId);
    if (!rows.length) continue;

    const name = thread.name || extractName(rows);
    if (name && !thread.name) repo.dmThreads.setName(chatId, name);

    try {
      const { status } = await ensureCrmLead(crm, thread, name);

      // Held for a human, or no number to match on. Either way the messages stay
      // unsynced and are picked up again next cycle.
      if (status !== 'ok') {
        failed += 1;
        continue;
      }

      await pushDmMessages(crm, repo.dmThreads.byChatId(chatId));
      repo.dmThreads.markSynced(chatId);
      synced += 1;
    } catch (error) {
      logger.warn(`DM→CRM sync failed for ${chatId}: ${error.message}`);
      repo.dmThreads.markFailed(chatId, error.message);
      failed += 1;
    }
  }

  logger.info(`DM→CRM sync: ${synced} conversation(s) synced, ${failed} failed`);
  return { synced, failed };
}

module.exports = {
  syncDmConversations, ensureCrmLead, pushDmMessages, extractName
};
