/**
 * Bank groups (Way 2).
 *
 * These are the lender's groups, not ours. We control nothing: not the people,
 * not the format, and there are no mentions to work from. So the rules are
 * narrower than Way 1's.
 *
 *   A message carrying a phone number that matches a lead
 *      -> that lead has been shared with this bank
 *
 *   A message carrying a phone number that matches nothing
 *      -> tell our own team, in our own group
 *
 *   Anything else about a lead already shared here
 *      -> keep it as conversation against that lead and this bank
 *
 * The bot never posts in a bank group. That is enforced in the database — a group
 * whose purpose is `bank` has sending forced off and cannot have it turned back on.
 */
const phoneUtil = require('./phone');
const noise = require('./noise');
const repo = require('../db/repositories');
const logger = require('../logger');
const { prettyPhone } = require('./replies');

/** Give up after this many attempts, as elsewhere. */
const MAX_ATTEMPTS = 8;

/**
 * What a message in a bank group is about.
 *
 * @param {{ text: string|null, mentions: string[] }} message
 * @returns {{ kind: 'share'|'chatter'|'ignore', phones: string[], reason: string|null }}
 */
function classify(message) {
  const text = message?.text || '';
  if (!text.trim()) return { kind: 'ignore', phones: [], reason: 'no_text' };

  const noiseCheck = noise.classify(text);
  if (noiseCheck.isNoise) {
    return { kind: 'ignore', phones: [], reason: `noise_${noiseCheck.reason}` };
  }

  // A mentioned person is a human in the group, never the lead being discussed.
  const mentioned = new Set(message.mentions || []);
  const phones = phoneUtil.extract(text).filter((p) => !mentioned.has(p));

  if (phones.length === 0) return { kind: 'chatter', phones: [], reason: null };

  return { kind: 'share', phones, reason: null };
}

/**
 * The message posted in OUR group when a lead is shared with a bank but is not in
 * the CRM.
 *
 * Deliberately posted where our team is, never in the bank's group.
 */
function unknownLeadNotice({ phone, bank, groupName, sharedBy }) {
  return {
    text: `⚠️ Shared with ${bank} but not in the CRM\n`
      + `${prettyPhone(phone)}\n`
      + `${groupName}${sharedBy ? ` · by ${sharedBy}` : ''}\n`
      + 'Add it to the CRM, or check the number',
    mentions: []
  };
}

class BankHandler {
  /**
   * @param {{ crm: object, whatsapp: object }} deps
   */
  constructor({ crm, whatsapp }) {
    this.crm = crm;
    this.whatsapp = whatsapp;
  }

  /**
   * Handle a message seen in a bank group.
   *
   * @param {object} message - normalised
   * @param {object} group - the groups row, with bank_name set
   */
  async handle(message, group) {
    if (!group.bank_name) {
      // Without a bank we cannot record anything, and guessing from the group's
      // name would eventually guess wrong.
      repo.skipped.record({
        waMessageId: message.id, groupId: group.id, body: message.text || '',
        reason: 'bank_not_mapped', senderPhone: message.senderPhone
      });
      return;
    }

    const result = classify(message);

    if (result.kind === 'ignore') {
      repo.skipped.record({
        waMessageId: message.id, groupId: group.id, body: message.text || '',
        reason: result.reason, senderPhone: message.senderPhone
      });
      return;
    }

    if (result.kind === 'chatter') {
      return this.handleChatter(message, group);
    }

    for (const phone of result.phones) {
      await this.handleShare(message, group, phone);
    }
  }

  /**
   * A message naming a phone number: the lead has been shared with this bank.
   * @private
   */
  async handleShare(message, group, phone) {
    const employee = message.senderPhone
      ? repo.employees.byPhone(message.senderPhone)
      : null;

    // Recorded before the CRM is called, so a redelivery or a failure mid-flight
    // is recoverable rather than duplicate-producing.
    const share = repo.bankShares.create({
      waMessageId: `${message.id}:${phone}`,
      groupId: group.id,
      bankName: group.bank_name,
      phone,
      senderPhone: message.senderPhone,
      employeeId: employee?.id || null,
      rawMessage: message.text || ''
    });

    if (!share) return; // already seen

    await this.pushShare(share, group, message);
  }

  /**
   * Send a share to the CRM. Safe to call again — used by the retry worker too.
   *
   * @param {object} share - the bank_shares row
   * @param {object} [group]
   * @param {object} [message] - the original, when handling live
   */
  async pushShare(share, group, message) {
    repo.bankShares.recordAttempt(share.id);

    try {
      const match = await this.crm.findByPhone(share.phone);

      if (match.status === 'ambiguous') {
        // Several leads carry this number. Recording the share against the wrong
        // one is worse than not recording it, and telling the team it does not
        // exist would simply be false.
        repo.bankShares.markFailed(share.id,
          `${match.candidates} leads share this number — cannot tell which`);
        logger.error(`${share.phone} matches ${match.candidates} leads — share not recorded`);
        return;
      }

      if (match.status === 'none') {
        // Not a lead we hold. Real information, but unexpected — our own team
        // should look at it.
        repo.bankShares.markUnknown(share.id);
        logger.warn(`Shared with ${share.bank_name} but not in CRM: ${share.phone}`);
        await this.notifyUnknown(share, group);
        return;
      }

      const lead = match.lead;

      const employee = share.employee_id
        ? repo.employees.all().find((e) => e.id === share.employee_id)
        : null;

      await this.crm.recordBankShare(lead.id, {
        bankName: share.bank_name,
        sharedBy: employee?.crm_profile_id,
        sharedAt: share.created_at ? new Date(share.created_at + 'Z').toISOString() : undefined,
        waGroupId: group?.wa_group_id
      });

      repo.bankShares.markRecorded(share.id, lead.id);
      logger.info(`${lead.full_name || share.phone} shared with ${share.bank_name}`);

      // The message that did the sharing is itself the first line of the
      // conversation about this lead at this bank.
      if (message?.text) {
        await this.captureMessage(message, group, lead.id, share.bank_name);
      }
    } catch (error) {
      const attempts = share.attempts + 1;
      repo.bankShares.recordError(share.id, error.message);
      if (attempts >= MAX_ATTEMPTS) {
        repo.bankShares.markFailed(share.id, error.message);
        logger.error(`Bank share ${share.id} failed after ${attempts}: ${error.message}`);
      } else {
        logger.warn(`Bank share ${share.id} attempt ${attempts}: ${error.message}`);
      }
    }
  }

  /**
   * A message with no phone number. If it replies to something we linked to a
   * lead, it belongs to that conversation.
   * @private
   */
  async handleChatter(message, group) {
    let target = null;

    if (message.quotedId) {
      // The quoted message may itself have been a share.
      const parent = repo.bankShares.byWaMessageId(message.quotedId)
        || [...Array(1)].map(() => null)[0];

      if (parent?.crm_lead_id) {
        target = { leadId: parent.crm_lead_id, bank: parent.bank_name };
      } else {
        // Shares are keyed "<messageId>:<phone>", so look for any share from that
        // message.
        const row = require('../db').get().prepare(
          "SELECT * FROM bank_shares WHERE wa_message_id LIKE ? AND crm_lead_id IS NOT NULL LIMIT 1"
        ).get(`${message.quotedId}:%`);
        if (row) target = { leadId: row.crm_lead_id, bank: row.bank_name };
      }
    }

    if (!target) {
      repo.skipped.record({
        waMessageId: message.id, groupId: group.id, body: message.text || '',
        reason: 'bank_chatter', senderPhone: message.senderPhone
      });
      return;
    }

    await this.captureMessage(message, group, target.leadId, target.bank);
  }

  /**
   * Store a message against a lead and bank, then send it.
   * @private
   */
  async captureMessage(message, group, crmLeadId, bankName) {
    const employee = message.senderPhone
      ? repo.employees.byPhone(message.senderPhone)
      : null;

    const record = repo.bankMessages.create({
      waMessageId: message.id,
      groupId: group?.id || null,
      bankName,
      crmLeadId,
      body: message.text || '',
      senderPhone: message.senderPhone,
      isOurTeam: employee ? 1 : 0
    });

    if (!record) return; // already seen

    await this.pushMessage(record, employee?.name);
  }

  /** Send a captured message to the CRM. Safe to call again. */
  async pushMessage(record, senderName) {
    repo.bankMessages.recordAttempt(record.id);

    try {
      await this.crm.addBankMessage(record.crm_lead_id, record.bank_name, {
        body: record.body,
        senderPhone: record.sender_phone,
        senderName,
        isOurTeam: Boolean(record.is_our_team),
        waMessageId: record.wa_message_id
      });
      repo.bankMessages.markApplied(record.id);
    } catch (error) {
      const attempts = record.attempts + 1;
      repo.bankMessages.recordError(record.id, error.message);
      if (attempts >= MAX_ATTEMPTS) {
        repo.bankMessages.markFailed(record.id, error.message);
      }
      logger.warn(`Bank message ${record.id} failed: ${error.message}`);
    }
  }

  /**
   * Tell our own team about a lead we do not hold.
   * @private
   */
  async notifyUnknown(share, group) {
    if (share.notified) return;

    const employee = share.employee_id
      ? repo.employees.all().find((e) => e.id === share.employee_id)
      : null;

    const notice = unknownLeadNotice({
      phone: share.phone,
      bank: share.bank_name,
      groupName: group?.name || 'a bank group',
      sharedBy: employee?.name
    });

    // Posted where our team is. Never in the bank's group.
    for (const target of repo.groups.active()) {
      if (target.purpose !== 'inhouse' || !target.send_enabled) continue;
      const sent = await this.whatsapp.reply({
        groupId: target.wa_group_id, text: notice.text
      });
      if (sent) repo.bankShares.markNotified(share.id);
    }
  }
}

module.exports = { BankHandler, classify, unknownLeadNotice };
