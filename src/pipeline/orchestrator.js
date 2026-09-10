/**
 * The pipeline: a WhatsApp message in, a CRM lead out.
 *
 *   message in a monitored group
 *        │
 *        ├─ is it a reply to a lead we know?  ──> update that lead
 *        └─ otherwise                          ──> is it a new lead?
 *
 * Two principles run through all of it:
 *
 *   Record before acting. Every message is written to our database BEFORE the CRM
 *   is called. WhatsApp redelivers after a reconnect and a network failure leaves
 *   us unable to tell whether the CRM committed — recording first makes both
 *   recoverable instead of producing duplicate leads.
 *
 *   Never lose information. A message we cannot use is stored with a reason, not
 *   dropped. Held leads wait for a human; unrecognised text becomes a remark.
 */
const detect = require('./detect');
const phoneUtil = require('./phone');
const noise = require('./noise');
const labelParser = require('./labels');
const { replies } = require('./replies');
const { LOCKED_LISTS } = require('../crm/fields');
const commands = require('./commands');
const { buildMyLeads } = require('./digest');
const { ensureCrmLead, pushDmMessages } = require('./dmSync');
const { BankHandler } = require('./bank');
const { DuplicateLeadError, CrmClient } = require('../crm/client');
const repo = require('../db/repositories');
const { config } = require('../config');
const logger = require('../logger');
const assistant = require('../ai/assistant');
const extract = require('../ai/extract');

/** Give up after this many CRM attempts and mark the lead failed. */
const MAX_ATTEMPTS = 8;

class Orchestrator {
  /**
   * @param {{ crm: import('../crm/client').CrmClient, whatsapp: object }} deps
   */
  constructor({ crm, whatsapp }) {
    this.crm = crm;
    this.whatsapp = whatsapp;
    this.bank = new BankHandler({ crm, whatsapp });
    /** chat id -> the tail of that chat's work queue. See serialise(). */
    this.chatQueues = new Map();
  }

  /**
   * Run work for one chat only after everything already queued for it.
   *
   * Handling a message is slow — a model call, then the CRM, then another model
   * call — and messages arrive on their own schedule. Left concurrent, a second
   * message that lands mid-flight produces a second reply while the first is
   * still being sent, and two overlapping sends on one WhatsApp conversation
   * advance its encryption ratchet out of order. The recipient's phone then
   * cannot decrypt anything further and shows "Waiting for this message" for
   * every reply after the first few — which is exactly what was reported.
   *
   * Serialising per chat costs nothing: different customers still run in
   * parallel, and one customer's messages were always going to be answered in
   * order anyway.
   *
   * @private
   */
  serialise(key, work) {
    const previous = this.chatQueues.get(key) || Promise.resolve();
    // .catch first, so one failed message never blocks the rest of the chat.
    const run = previous.catch(() => {}).then(work);
    const tracked = run.catch(() => {});

    this.chatQueues.set(key, tracked);
    tracked.then(() => {
      // Only the newest entry may clear it, or a slow message would delete a
      // queue that a newer one is still using.
      if (this.chatQueues.get(key) === tracked) this.chatQueues.delete(key);
    });

    return run;
  }

  /**
   * Entry point for every incoming group message.
   * @param {object} message - normalised by whatsapp/messages.js
   * @param {object} [rawMessage] - the original, needed to quote it in a reply
   */
  async handle(message, rawMessage) {
    // Same reasoning as DMs: one group's messages are handled one at a time so
    // two replies can never be sent into it concurrently.
    return this.serialise(message.groupId, () => this.processGroup(message, rawMessage));
  }

  /** @private */
  async processGroup(message, rawMessage) {
    try {
      const group = repo.groups.upsert(message.groupId, message.groupName || message.groupId);

      if (!group.is_active) return;

      // The point to ask the phone to replay from after a gap. Recorded for every
      // message we see, whether or not it turns out to be a lead.
      repo.groups.setWatermark(message.groupId, {
        id: message.id,
        timestamp: message.timestamp,
        fromMe: message.fromMe
      });

      if (group.purpose === 'bank') {
        // A different set of rules entirely — see pipeline/bank.js. The bot never
        // posts in these groups.
        return await this.bank.handle(message, group);
      }

      const command = commands.parse(message.text);
      if (command) return await this.handleCommand(command, message, group, rawMessage);

      if (message.quotedId) {
        const parent = repo.leads.byWaMessageId(message.quotedId);
        if (parent) return await this.handleReply(message, parent, group, rawMessage);
        // A reply to something that is not a lead is ordinary conversation.
      }

      return await this.handleNewLead(message, group, rawMessage);
    } catch (error) {
      // A failure here must never take the connection down — staying connected
      // matters more than any single message.
      logger.error(`Pipeline error on ${message?.id}: ${error.stack || error.message}`);
    }
  }

  /**
   * Answer a command.
   *
   * Read-only, and the reply is always addressed to whoever asked — a command is
   * a question from one person, not an announcement to the group.
   *
   * @private
   */
  async handleCommand(command, message, group, rawMessage) {
    repo.skipped.record({
      waMessageId: message.id, groupId: group.id, body: message.text || '',
      reason: `command_${command.name}`, senderPhone: message.senderPhone
    });

    if (command.name === 'help') {
      await this.send(group, { text: commands.HELP_TEXT, mentions: [] }, rawMessage);
      return;
    }

    if (command.name === 'myLeads') {
      const employee = message.senderPhone
        ? repo.employees.byPhone(message.senderPhone)
        : null;

      // Someone not in the employee map is ignored, not answered. They have no
      // leads to show, and telling every non-employee how to add themselves would
      // just be noise in a group where most people are not counsellors.
      if (!employee) return;

      const result = await buildMyLeads(this.crm, employee.crm_profile_id)
        .catch((error) => {
          logger.warn(`my-leads failed for ${employee.name}: ${error.message}`);
          return null;
        });

      await this.send(group, {
        text: result ? result.text : '⚠️ Couldn\'t reach the CRM just now — try again shortly',
        mentions: []
      }, rawMessage);
    }
  }

  /**
   * A message that is not a reply: decide whether it is a new lead.
   * @private
   */
  async handleNewLead(message, group, rawMessage) {
    // A message may list several leads under one tag. Handled separately,
    // because taking only the first would silently drop the rest.
    const batch = detect.splitLeads(message.text, message.mentions);
    if (batch) return await this.handleBatch(batch, message, group, rawMessage);

    const result = detect.classify(message);

    if (!result.isLead) {
      // Somebody tagged a colleague and wrote something number-shaped that could
      // not be read. That is a lead attempt, not conversation, and staying quiet
      // leaves them believing it worked — which is exactly how two leads were
      // lost on 2 Sep 2026. Ordinary chat has no number in it and stays silent.
      const unreadable = result.reason === 'no_phone'
        ? phoneUtil.findUnreadable(message.text)
        : [];

      const fresh = repo.skipped.record({
        waMessageId: message.id, groupId: group.id,
        body: message.text || '',
        reason: unreadable.length ? 'unreadable_number' : result.reason,
        senderPhone: message.senderPhone
      });

      if (unreadable.length && fresh) {
        logger.warn(`Unreadable number from ${message.senderPhone || 'someone'}: `
          + `${unreadable.join(', ')}`);
        await this.send(group, replies.unreadableNumber({
          name: detect.extractName(message.text), raw: unreadable[0]
        }), rawMessage);
      } else {
        // Ordinary conversation — no number, no unreadable number, nothing for
        // the lead pipeline to do. Hand it to the AI assistant instead of
        // staying silent, if that's turned on for this group.
        await this.maybeAiReply(message, group, rawMessage);
      }
      return;
    }

    // Resolve the mention to an employee before recording, so the row is complete.
    const mentionedPhone = result.mentions[0] || null;
    const employee = mentionedPhone ? repo.employees.byPhone(mentionedPhone) : null;

    const heldReason = result.reason
      || (mentionedPhone && !employee ? 'unknown_employee' : null);

    const lead = repo.leads.create({
      waMessageId: message.id,
      groupId: group.id,
      name: result.name,
      phone: result.phone,
      senderPhone: message.senderPhone,
      rawMessage: message.text || '',
      mentionedPhone,
      employeeId: employee?.id || null,
      status: heldReason ? 'held' : 'pending',
      heldReason
    });

    // Already seen — WhatsApp redelivered it. Doing nothing is the correct action.
    if (!lead) return;

    if (heldReason) {
      logger.info(`Lead held (${heldReason}): ${result.name || 'unnamed'} ${result.phone}`);
      await this.replyHeld(lead, result, group, rawMessage);
      return;
    }

    await this.pushLead(lead, result, group, rawMessage);
  }

  /**
   * A message listing several leads.
   *
   * Each is created independently — one failing, or one already existing, must
   * not stop the others. The group gets a single reply for the batch.
   *
   * @private
   */
  async handleBatch(entries, message, group, rawMessage) {
    const mentionedPhone = message.mentions?.[0] || null;
    const employee = mentionedPhone ? repo.employees.byPhone(mentionedPhone) : null;

    // The assignee problem is the same for the whole batch, so it is answered
    // once rather than per lead.
    const heldReason = message.mentions?.length === 0 ? 'no_mention'
      : message.mentions?.length > 1 ? 'multiple_mentions'
        : (mentionedPhone && !employee ? 'unknown_employee' : null);

    const created = [];
    const existing = [];
    const failed = [];
    let firstHeld = null;

    for (const entry of entries) {
      // Keyed on message id plus phone: one message, several leads, and a
      // redelivery still creates none of them twice.
      const lead = repo.leads.create({
        waMessageId: `${message.id}:${entry.phone}`,
        groupId: group.id,
        name: entry.name,
        phone: entry.phone,
        senderPhone: message.senderPhone,
        rawMessage: entry.line,
        mentionedPhone,
        employeeId: employee?.id || null,
        status: heldReason ? 'held' : 'pending',
        heldReason
      });

      if (!lead) continue; // already seen

      if (heldReason) {
        firstHeld = firstHeld || lead;
        continue;
      }

      const outcome = await this.pushLead(lead, {
        name: entry.name, phone: entry.phone, fields: {}, remarkText: null
      }, null, undefined);

      if (outcome?.status === 'existing') {
        existing.push({ name: entry.name, phone: entry.phone, owner: outcome.owner });
      } else if (outcome?.status === 'created') {
        created.push({ name: entry.name, phone: entry.phone });
      } else {
        failed.push({ name: entry.name, phone: entry.phone });
      }
    }

    if (!group) return;

    // Whatever blocked the batch blocked all of it, so say it once.
    if (heldReason && firstHeld) {
      logger.info(`Batch of ${entries.length} held (${heldReason})`);
      return await this.replyHeld(firstHeld, {
        name: null, phone: null, mentions: message.mentions || []
      }, group, rawMessage);
    }

    if (!created.length && !existing.length && !failed.length) return;

    logger.info(`Batch: ${created.length} created, ${existing.length} existing, `
      + `${failed.length} failed`);

    await this.send(group, replies.batchCreated(
      { created, existing, failed }, employee?.wa_phone
    ), rawMessage);
  }

  /**
   * Tell the group why a lead is waiting (messages 3, 3b, 3c, 4).
   * @private
   */
  async replyHeld(lead, result, group, rawMessage) {
    let reply;

    switch (lead.held_reason) {
      case 'no_mention': {
        // A number posted with no tag is usually a question — "who has this one?"
        // Answering it is more useful than asking them to tag someone, and the
        // lookup is read-only.
        // A lookup that failed is not an answer. Falling back to "please tag
        // someone" is the safe response either way.
        const match = await this.crm.findByPhone(result.phone)
          .catch(() => ({ status: 'error', lead: null }));
        const existing = match.status === 'found' ? match.lead : null;

        if (existing) {
          repo.leads.markExisting(lead.id, existing.id);
          await this.crm.addRemark(
            existing.id,
            `Shared again in WhatsApp by ${lead.sender_phone || 'a team member'}`
              + `\n\n${lead.raw_message}`,
            lead.wa_message_id
          ).catch(() => {});

          reply = replies.leadExists({
            name: result.name,
            phone: result.phone,
            lead: existing,
            resolveUser: (id) => (id ? this.crm.users?.get(id)?.full_name : null)
          });
          break;
        }

        reply = replies.needsMention({ name: result.name, phone: result.phone });
        break;
      }
      case 'multiple_mentions': {
        const names = result.mentions.map(
          (p) => repo.employees.byPhone(p)?.name || p
        );
        reply = replies.tooManyMentions({ employeeNames: names });
        break;
      }
      case 'unknown_employee':
        reply = replies.unknownEmployee({
          name: result.name, phone: result.phone, mentionedPhone: lead.mentioned_phone
        });
        break;
      default:
        return;
    }

    await this.send(group, reply, rawMessage, () => repo.leads.markReplied(lead.id));
  }

  /**
   * Create the lead in the CRM.
   *
   * Called both on arrival and by the retry worker, so it must be safe to run
   * more than once for the same lead.
   *
   * @param {object} lead - the database row
   * @param {object} [parsed] - detection result, re-derived if absent
   */
  async pushLead(lead, parsed, group, rawMessage) {
    const result = parsed || detect.classify({
      text: lead.raw_message,
      mentions: lead.mentioned_phone ? [lead.mentioned_phone] : []
    });

    const employee = lead.employee_id
      ? repo.employees.all().find((e) => e.id === lead.employee_id)
      : null;

    if (!employee) {
      repo.leads.markHeld(lead.id, 'unknown_employee');
      return { status: 'held' };
    }

    repo.leads.recordAttempt(lead.id);

    try {
      // The CRM requires a name, but the phone number is what identifies a lead.
      // Showing the number is honest and searchable; a reply carrying "Name: X"
      // replaces it later.
      const displayName = lead.name || lead.phone;

      const { lead: created, deferred } = await this.crm.createLead({
        full_name: displayName,
        phone: lead.phone,
        assigned_agent_id: employee.crm_profile_id,
        ...result.fields
      });

      repo.leads.markCreated(lead.id, created.id);

      // loan_amount and bank_name cannot be set on create (C11) — patch them now
      // rather than losing them.
      if (Object.keys(deferred).length) {
        await this.crm.updateLead(created.id, deferred).catch((e) =>
          logger.warn(`Deferred field patch failed for ${created.id}: ${e.message}`));
      }

      if (result.remarkText) {
        await this.crm.addRemark(created.id, result.remarkText, lead.wa_message_id)
          .catch((e) => logger.warn(`Remark failed for ${created.id}: ${e.message}`));
      }

      logger.info(`Lead created: ${lead.name} (${lead.phone}) → ${employee.name}`);

      if (group) {
        await this.send(group, replies.leadCreated({
          name: lead.name, phone: lead.phone, employeePhone: employee.wa_phone
        }), rawMessage, () => repo.leads.markReplied(lead.id));
      }

      return { status: 'created', crmLeadId: created.id };
    } catch (error) {
      if (error instanceof DuplicateLeadError) {
        // Q5 — the existing lead keeps its current owner. The message is preserved
        // as a remark so nothing is lost and a human can reassign if needed.

        // But if that lead is finished — disbursed, lost, enrolled — a remark lands
        // on a record nobody is watching. On a large lead base "lost" is common, so
        // a genuinely revived enquiry would be buried on a dead record. Hold it.
        // Fetched so the group can be told where this lead actually stands,
        // and so a finished lead is not silently appended to.
        let existing = null;
        if (error.existingLeadId) {
          existing = await this.crm.getLead(error.existingLeadId).catch(() => null);
        }

        if (existing && CrmClient.isTerminal(existing)) {
          repo.leads.markHeld(lead.id, `revived_${existing.current_stage}`);
          logger.warn(`Lead ${lead.phone} matches a ${existing.current_stage} lead `
            + `(${error.existingLeadId}) — held for review`);

          if (group) {
            await this.send(group, replies.revivedLead({
              phone: lead.phone,
              existingName: existing.full_name,
              stage: existing.current_stage
            }), rawMessage, () => repo.leads.markReplied(lead.id));
          }
          return { status: 'held', reason: `revived_${existing.current_stage}` };
        }

        repo.leads.markExisting(lead.id, error.existingLeadId);

        if (error.existingLeadId) {
          await this.crm.addRemark(
            error.existingLeadId,
            `Re-shared in WhatsApp by ${lead.sender_phone || 'a team member'}`
              + `, tagged ${employee.name}\n\n${lead.raw_message}`,
            lead.wa_message_id
          ).catch((e) => logger.warn(`Remark on duplicate failed: ${e.message}`));
        }

        logger.info(`Lead already exists: ${lead.phone} → ${error.existingLeadId}`);

        if (group) {
          await this.send(group, replies.leadExists({
            name: lead.name,
            phone: lead.phone,
            existingName: error.existingLeadName,
            lead: existing,
            // The single-lead response does not always populate agent names, so
            // resolve them from the cached user list instead.
            resolveUser: (id) => (id ? this.crm.users?.get(id)?.full_name : null)
          }), rawMessage, () => repo.leads.markReplied(lead.id));
        }

        return {
          status: 'existing',
          crmLeadId: error.existingLeadId,
          owner: existing
            ? (existing.assigned_agent_name
               || this.crm.users?.get(existing.assigned_agent_id)?.full_name)
            : null
        };
      }

      const attempts = lead.attempts + 1;
      repo.leads.recordError(lead.id, error.message);

      if (attempts >= MAX_ATTEMPTS) {
        repo.leads.markFailed(lead.id, error.message);
        logger.error(`Lead ${lead.id} failed after ${attempts} attempts: ${error.message}`);
      } else {
        logger.warn(`Lead ${lead.id} attempt ${attempts} failed: ${error.message}`);
      }

      // S6 — announce trouble once, never once per retry.
      if (group && !lead.replied) {
        await this.send(group, replies.crmUnavailable({
          name: lead.name, phone: lead.phone
        }), rawMessage, () => repo.leads.markReplied(lead.id));
      }

      return { status: 'failed', error: error.message };
    }
  }

  /**
   * Move a lead to someone else.
   *
   * The one place the bot changes who owns existing work, so every step is
   * explicit: an unambiguous instruction, a check that the lead is still open,
   * a loud announcement naming both sides, and a permanent record in the CRM.
   *
   * @private
   */
  async handleReassign(instruction, message, parent, group, rawMessage) {
    const refuse = (reason, extra = {}) => this.send(group, replies.reassignRefused({
      reason, name: parent.name, phone: parent.phone, ...extra
    }), rawMessage);

    // Moving a lead takes it off whoever had it, so this is restricted rather
    // than open to everyone in the employee map.
    if (!config.reassignAllowed.includes(message.senderPhone)) {
      logger.warn(`Reassign refused — ${message.senderPhone} is not permitted`);
      return refuse('not_permitted');
    }

    if (instruction.error) return refuse(instruction.error);
    if (!parent.crm_lead_id) return refuse('not_a_lead');

    const target = repo.employees.byPhone(instruction.to);
    if (!target) return refuse('unknown_employee');

    const lead = await this.crm.getLead(parent.crm_lead_id).catch(() => null);
    if (!lead) return refuse('not_a_lead');

    // A finished lead should be reopened deliberately, not moved sideways.
    if (CrmClient.isTerminal(lead)) {
      return refuse('closed', { stage: lead.current_stage });
    }

    if (lead.assigned_agent_id === target.crm_profile_id) {
      return refuse('same_person');
    }

    const fromName = this.crm.users?.get(lead.assigned_agent_id)?.full_name || null;
    const byName = message.senderPhone
      ? (repo.employees.byPhone(message.senderPhone)?.name || message.senderPhone)
      : null;

    try {
      await this.crm.updateLead(parent.crm_lead_id, {
        assigned_agent_id: target.crm_profile_id
      });

      await this.crm.addRemark(
        parent.crm_lead_id,
        `Reassigned from ${fromName || 'unassigned'} to ${target.name}`
          + (byName ? ` by ${byName}` : '') + ' via WhatsApp',
        message.id
      ).catch((error) => logger.warn(`Reassign remark failed: ${error.message}`));

      repo.leads.assign(parent.id, target.id, target.wa_phone);
      repo.leads.markCreated(parent.id, parent.crm_lead_id);

      logger.info(`Lead ${parent.phone} moved ${fromName || 'unassigned'} → ${target.name}`);

      await this.send(group, replies.leadReassigned({
        name: lead.full_name || parent.name,
        phone: parent.phone,
        from: fromName,
        toPhone: target.wa_phone,
        toName: target.name,
        by: byName
      }), rawMessage);
    } catch (error) {
      logger.error(`Reassign failed for ${parent.crm_lead_id}: ${error.message}`);
      await this.send(group, replies.reassignRefused({
        reason: 'failed', name: parent.name, phone: parent.phone
      }), rawMessage);
    }
  }

  /**
   * A reply to a known lead: field updates, remarks, or nothing at all.
   * @private
   */
  async handleReply(message, parent, group, rawMessage) {
    const text = message.text || '';

    // Checked first: "assign @Zaid" is an instruction about the lead, not a
    // detail to record on it.
    const reassign = commands.parseReassign(text, message.mentions);
    if (reassign) {
      repo.skipped.record({
        waMessageId: message.id, groupId: group.id, body: text,
        reason: 'command_reassign', senderPhone: message.senderPhone
      });
      return await this.handleReassign(reassign, message, parent, group, rawMessage);
    }

    // R11.1 — acknowledgements never reach the CRM, but are kept here so the
    // noise list can be corrected against how people actually talk.
    const noiseCheck = noise.classify(text);
    if (noiseCheck.isNoise) {
      repo.skipped.record({
        waMessageId: message.id, groupId: group.id, body: text,
        reason: `noise_${noiseCheck.reason}`, senderPhone: message.senderPhone
      });
      return;
    }

    const parsed = labelParser.parse(text);

    // The same inference a new lead gets. Without this, "Bharath University
    // Chennai" filled the university field in a first message but landed in notes
    // when it arrived as a reply.
    const inferred = detect.inferFields(text, parsed.fields);
    Object.assign(parsed.fields, inferred.fields);

    const hasFields = Object.keys(parsed.fields).length > 0;

    // Anything not understood is preserved verbatim (R11.5).
    const remarkParts = [
      ...parsed.plain.filter((line) => !inferred.consumed.includes(line)),
      ...parsed.rejected.map((r) => `${r.label}: ${r.value}`)
    ];

    const record = repo.leadUpdates.create({
      waMessageId: message.id,
      leadId: parent.id,
      kind: hasFields ? 'fields' : 'remark',
      payload: JSON.stringify(parsed.fields),
      body: text,
      senderPhone: message.senderPhone
    });

    if (!record) return; // redelivered

    await this.applyUpdate(record, parent, parsed, remarkParts, group, rawMessage);
  }

  /**
   * Send a reply's contents to the CRM.
   * Safe to call again — used by the retry worker too.
   */
  async applyUpdate(record, parent, parsed, remarkParts, group, rawMessage) {
    if (!parent.crm_lead_id) {
      // The parent has not reached the CRM yet. Leave it pending; the retry worker
      // will pick it up once the lead exists.
      return;
    }

    repo.leadUpdates.recordAttempt(record.id);

    try {
      // Read before writing, so a value replacing another can be reported and
      // kept. Overwriting a counsellor's entry silently is how trust is lost.
      const current = Object.keys(parsed.fields).length
        ? await this.crm.getLead(parent.crm_lead_id).catch(() => null)
        : null;

      const changes = [];
      const toWrite = {};

      for (const [field, value] of Object.entries(parsed.fields)) {
        const from = current ? current[field] : undefined;
        // Writing a value that is already there is noise in the audit trail.
        if (from !== undefined && from !== null && String(from) === String(value)) continue;
        toWrite[field] = value;
        changes.push({ field, from: from || null, to: value });
      }

      if (Object.keys(toWrite).length) {
        await this.crm.updateLead(parent.crm_lead_id, toWrite);
      }

      // Anything replaced is recorded, so a correction never destroys history.
      const replaced = changes.filter((c) => c.from);
      const notes = [...remarkParts];
      if (replaced.length) {
        notes.push(...replaced.map((c) =>
          `${c.field} changed from "${c.from}" to "${c.to}"`));
      }

      if (notes.length) {
        await this.crm.addRemark(parent.crm_lead_id, notes.join('\n'),
          record.wa_message_id);
      }

      repo.leadUpdates.markApplied(record.id);

      if (group && !record.replied) {
        // Confirm what landed, and explain what did not — this is how the team
        // learns the labelled format (R9).
        // One message in, one message out (S2). A reply listing several things
        // must not produce a reply per line.
        const parts = [];
        if (changes.length) parts.push(replies.fieldsUpdated(changes).text);

        const refused = replies.labelRejected(parsed.rejected);
        if (refused) parts.push(refused.text);

        // Several figures and no total: say so, rather than quietly recording
        // nothing and looking like it missed the message.
        if (!changes.some((c) => c.field === 'loan_amount')) {
          // record.body, not `text` — applyUpdate is also called by the retry
          // worker, where the original message is long gone.
          const amounts = labelParser.amountCandidates(record.body, parsed.rejected);
          if (amounts.length > 1) parts.push(replies.amountAmbiguous(amounts).text);
        }

        if (parts.length) {
          await this.send(group, { text: parts.join('\n'), mentions: [] },
            rawMessage, () => repo.leadUpdates.markReplied(record.id));
        }
      }
    } catch (error) {
      const attempts = record.attempts + 1;
      repo.leadUpdates.recordError(record.id, error.message);
      if (attempts >= MAX_ATTEMPTS) {
        repo.leadUpdates.markFailed(record.id, error.message);
      }
      logger.warn(`Update ${record.id} failed: ${error.message}`);
    }
  }

  /**
   * Answer a DM to the bot's own number with an AI-generated reply.
   *
   * Unlike the group pipeline there is no lead here at arrival time and no
   * @mention to key off — but the conversation itself is still captured (both
   * directions, into dm_messages/dm_threads) so it can be synced to the CRM
   * later. See pipeline/dmSync.js and the 'dm-crm-sync' scheduled job.
   */
  async handleDirect(message, rawMessage) {
    // One chat is answered one message at a time — see serialise().
    return this.serialise(message.chatId, () => this.processDirect(message, rawMessage));
  }

  /** @private */
  async processDirect(message, rawMessage) {
    try {
      if (message.fromMe) return;

      const text = (message.text || '').trim();
      if (!text) return;

      // Record before acting, same principle as the group pipeline: capture the
      // customer's message even if the AI reply below is off, fails, or the
      // send later gets rate-limited — the conversation itself is the thing we
      // must not lose.
      // The chat may be addressed by LID, which is not a phone number. Prefer
      // the real number WhatsApp sends alongside; if there is none, record no
      // number rather than inventing one from the LID's digits — a lead under a
      // number nobody can call is worse than a lead waiting for one.
      const phone = phoneUtil.fromJidInternational(message.senderPnJid || message.chatId);
      repo.dmThreads.upsert(message.chatId, phone);

      // WhatsApp redelivers after a reconnect, and a failed decrypt is retried.
      // The group pipeline has always stopped here on a message it has already
      // seen; this path never did, so a replay produced a second reply to the
      // same message — and two sends the recipient never asked for is one way
      // the conversation's encryption gets out of step.
      const fresh = this.recordDmMessage(message.chatId, 'in', text, message.id);
      if (!fresh) {
        logger.info(`Ignoring a message we have already answered (${message.id})`);
        return;
      }

      // Their WhatsApp profile name, so the lead is called something a person
      // recognises rather than its own number. Only ever fills a blank — a name
      // they actually told us in conversation is better, and must not be
      // overwritten by a profile name on a later message.
      if (message.pushName) repo.dmThreads.setNameIfBlank(message.chatId, message.pushName);

      // A LID-addressed chat often arrives with no number on the first message
      // and one on a later message, so every message is a fresh chance to
      // identify who we are talking to. The moment it lands, ensureDmLead below
      // creates the lead and the whole conversation stops being anonymous.
      if (phone && repo.dmThreads.setPhone(message.chatId, phone)) {
        logger.info(`Identified ${message.chatId} as ${phone} — creating the lead now`);
      }

      // Reply first, create the lead second. The CRM routinely takes 2-20s per
      // call and a customer waiting on a chatbot notices every one of them. The
      // conversation is already safe in our database by this point, so nothing
      // is at risk in doing the slow half afterwards.
      await this.replyToDm(message, rawMessage, text);
      await this.ensureDmLead(message.chatId);
      await this.captureDmFields(message.chatId);
    } catch (error) {
      logger.error(`Direct-message handling failed on ${message?.id}: ${error.message}`);
    }
  }

  /**
   * Answer a DM, if the assistant is switched on and sending is not paused.
   * @private
   */
  async replyToDm(message, rawMessage, text) {
    if (!config.ai.enabled || !config.ai.replyInDms) return;
    if (repo.settings.get('sending_paused') === 'true') return;

    const answer = await assistant.replyDirect(message.chatId, text);
    if (!answer) return;

    // First contact answers with two messages — the greeting and the details it
    // asks for — so this takes one or many and sends them in order.
    const parts = (Array.isArray(answer) ? answer : [answer]).filter(Boolean);

    for (const [index, part] of parts.entries()) {
      const sent = await this.whatsapp.reply({
        // replyTo, not chatId: a chat addressed by LID must be answered on the
        // sender's phone JID, or the reply is accepted without error and never
        // arrives. Falls back to chatId for an ordinary number-addressed chat.
        groupId: message.replyTo || message.chatId,
        text: part,
        // Only the first quotes what they wrote. Quoting the same message twice
        // reads as the bot repeating itself.
        quoteMessage: index === 0 ? rawMessage : undefined,
        mentions: []
      });

      // Outbound messages never come back through the WhatsApp event stream —
      // fromMe is filtered out before it reaches here — so this is the only
      // place the bot's half of the conversation ever gets recorded. Keyed on a
      // synthetic id (there is no real WhatsApp id to use), with the index so
      // two replies to one message stay two rows rather than collapsing into
      // one on the UNIQUE constraint.
      if (sent) {
        this.recordDmMessage(message.chatId, 'out', part,
          index === 0 ? `out:${message.id}` : `out:${message.id}:${index}`);
      }
    }
  }

  /**
   * Put the lead in the CRM as soon as someone messages, rather than waiting for
   * the nightly sync.
   *
   * The transcript still goes up once a day as a single tidy remark — a remark
   * per message would bury the record — but the lead itself exists from the
   * first message, so nobody has to wait until the evening to see it.
   *
   * A failure here is not fatal and is never announced: the conversation is
   * already recorded, and the retry worker creates the lead once the CRM is
   * reachable again.
   *
   * @private
   */
  async ensureDmLead(chatId) {
    if (!this.crm.configured) return;

    const thread = repo.dmThreads.byChatId(chatId);
    if (!thread || thread.crm_lead_id) return;

    try {
      const { status, leadId } = await ensureCrmLead(this.crm, thread);

      if (status === 'ok') {
        logger.info(`DM lead ready: ${thread.phone || chatId} → ${leadId}`);

        // Straight into the CRM's conversation view, as it happens. Anything
        // that fails here stays unsynced and the daily job picks it up, so a
        // CRM hiccup delays the inbox rather than losing the conversation.
        await pushDmMessages(this.crm, repo.dmThreads.byChatId(chatId),
          { selfPhone: this.whatsapp?.selfPhone })
          .catch((error) => logger.warn(
            `Chat messages not sent to the CRM yet for ${chatId}: ${error.message}`));
        return;
      }

      if (status === 'no_phone') {
        // The customer is having a normal conversation and getting good answers,
        // but WhatsApp has not told us their number, so there is no lead. Said
        // once per chat rather than per message: repeating it every time would
        // bury it, and it is the same fact each time.
        const messages = repo.dmMessages.recentForChat(chatId, 3).length;
        if (messages <= 1) {
          logger.warn(`Chatting with ${chatId} but WhatsApp has not given a phone `
            + 'number — no lead yet. It appears under "Needs attention" in the panel, '
            + 'and the lead is created automatically if a later message carries one.');
        }
      }
    } catch (error) {
      repo.dmThreads.markFailed(chatId, error.message);
      logger.warn(`DM lead not created yet for ${chatId}: ${error.message}`);
    }
  }

  /**
   * Read the conversation so far and write anything new into the CRM's fields.
   *
   * Runs after the reply, so it never adds to what the customer waits for, and
   * after the lead exists, so there is somewhere to write.
   *
   * Only genuinely new values are sent. The assistant re-reads the whole chat
   * each time and repeats facts it already reported, and rewriting an unchanged
   * value would fill the audit trail with writes that change nothing.
   *
   * A field already captured is never rewritten, even if the model later reads
   * the conversation differently — the first clear statement wins, and a
   * counsellor's manual correction is never overwritten by the bot.
   *
   * @private
   */
  async captureDmFields(chatId) {
    if (!config.ai.enabled || !config.ai.extractFields) return;
    if (!this.crm.configured) return;

    const thread = repo.dmThreads.byChatId(chatId);
    if (!thread?.crm_lead_id) return;

    try {
      const history = repo.dmMessages.recentForChat(chatId).map((row) => ({
        role: row.direction === 'in' ? 'user' : 'assistant',
        content: row.body
      }));

      const { fields } = await extract.extractFields(history);

      const already = repo.dmThreads.captured(chatId);
      const fresh = {};
      for (const [field, value] of Object.entries(fields)) {
        if (field in already) continue;
        fresh[field] = value;
      }

      if (!Object.keys(fresh).length) return;

      await this.crm.updateLead(thread.crm_lead_id, fresh);
      repo.dmThreads.setCaptured(chatId, fresh);

      // A real name replaces the phone number the lead was created under.
      if (fresh.full_name) repo.dmThreads.setName(chatId, fresh.full_name);

      logger.info(`DM lead ${thread.phone || chatId} updated: `
        + Object.entries(fresh).map(([k, v]) => `${k}=${v}`).join(', '));
    } catch (error) {
      // Never fatal. The transcript still reaches the CRM as a remark, so the
      // information survives even when no field was set.
      logger.warn(`DM field capture failed for ${chatId}: ${error.message}`);
    }
  }

  /**
   * Store one line of a DM conversation. Silently a no-op on a redelivered
   * message — wa_message_id is UNIQUE (INSERT OR IGNORE) — so this is safe to
   * call from a retried/replayed event.
   * @private
   */
  recordDmMessage(chatId, direction, body, waMessageId) {
    // Returns null when this id has been stored before, which is how callers
    // tell a new message from a redelivery.
    return repo.dmMessages.create({ waMessageId, chatId, direction, body });
  }

  /**
   * Answer ordinary (non-lead) chatter in a monitored group with an
   * AI-generated reply, if the AI assistant is turned on for groups.
   *
   * Bank groups never reach this — see the `purpose === 'bank'` branch in
   * `handle()`, and pipeline/bank.js for why that stays that way.
   * @private
   */
  async maybeAiReply(message, group, rawMessage) {
    if (!config.ai.enabled || !config.ai.replyInGroups) return;

    const text = (message.text || '').trim();
    if (!text) return;

    try {
      const answer = await assistant.reply(message.groupId, text);
      if (!answer) return;
      await this.send(group, { text: answer, mentions: [] }, rawMessage);
    } catch (error) {
      logger.warn(`AI group reply failed on ${message?.id}: ${error.message}`);
    }
  }

  /**
   * Send a reply, respecting the per-group switch and the kill switch.
   * @private
   */
  async send(group, reply, rawMessage, onSent) {
    if (!group.send_enabled) return;
    if (repo.settings.get('sending_paused') === 'true') return;

    const ok = await this.whatsapp.reply({
      groupId: group.wa_group_id,
      text: reply.text,
      mentions: reply.mentions,
      quoteMessage: rawMessage
    });

    if (ok && onSent) onSent();
  }
}

module.exports = { Orchestrator, MAX_ATTEMPTS };
