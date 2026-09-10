/**
 * Sync DM (1-on-1) chatbot conversations into the CRM.
 *
 * The group pipeline keys everything off an @mention (R8); a DM has none — the
 * chat itself is the lead. Once a day (see the 'dm-crm-sync' job in index.js)
 * this reads every chat with unsynced lines, finds or creates the matching CRM
 * lead by phone, and appends the transcript as one remark so a name, number and
 * "the chat that happened" show up in the CRM without anyone opening WhatsApp.
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
const { config } = require('../config');

const timeFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: config.timezone,
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
});

/** "[09 Sep, 6:42 pm] Customer: ..." */
function formatLine(row) {
  const who = row.direction === 'in' ? 'Customer' : 'Bot';
  // SQLite's datetime('now') is UTC with no offset marker — mark it explicitly
  // so Intl doesn't treat it as local time.
  const when = timeFormat.format(new Date(`${row.created_at.replace(' ', 'T')}Z`));
  return `[${when}] ${who}: ${row.body}`;
}

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

    const transcript = rows.map(formatLine).join('\n');
    const remark = `WhatsApp chat — ${rows.length} new message${rows.length === 1 ? '' : 's'}\n\n${transcript}`;

    const name = thread.name || extractName(rows);
    if (name && !thread.name) repo.dmThreads.setName(chatId, name);

    try {
      const { status, leadId } = await ensureCrmLead(crm, thread, name);

      // Held for a human, or no number to match on. Either way the transcript
      // stays unsynced and is picked up again next cycle.
      if (status !== 'ok') {
        failed += 1;
        continue;
      }

      await crm.addRemark(leadId, remark);
      repo.dmMessages.markSynced(rows.map((r) => r.id));
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

module.exports = { syncDmConversations, ensureCrmLead, formatLine, extractName };
