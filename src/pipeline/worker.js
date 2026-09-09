/**
 * Retry worker.
 *
 * Anything still owed to the CRM is picked up here: leads that failed on arrival,
 * leads captured while the CRM was down, and replies whose parent lead had not
 * reached the CRM yet.
 *
 * This is what makes a CRM outage a delay rather than a loss. v1 recorded a sync
 * failure once and never tried again, so an hour of downtime meant an hour of
 * leads gone.
 */
const repo = require('../db/repositories');
const labelParser = require('./labels');
const logger = require('../logger');

const DEFAULT_INTERVAL_MS = 60_000;
const BATCH_SIZE = 10;

class RetryWorker {
  /**
   * @param {{ orchestrator: import('./orchestrator').Orchestrator, intervalMs?: number }} deps
   */
  constructor({ orchestrator, intervalMs = DEFAULT_INTERVAL_MS }) {
    this.orchestrator = orchestrator;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Do not hold the process open purely for retries.
    this.timer.unref?.();
    logger.info(`Retry worker started (every ${Math.round(this.intervalMs / 1000)}s)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Never throws — a failing pass must not stop future ones.
   * @returns {Promise<{ leads: number, updates: number }>}
   */
  async tick() {
    // Overlapping passes would retry the same rows twice concurrently.
    if (this.running) return { leads: 0, updates: 0 };
    this.running = true;

    let leads = 0;
    let updates = 0;

    try {
      leads = await this.retryLeads();
      updates = await this.retryUpdates();
      const banks = await this.retryBankWork();
      if (leads || updates || banks) {
        logger.info(`Retry pass: ${leads} lead(s), ${updates} update(s), `
          + `${banks} bank item(s)`);
      }
    } catch (error) {
      logger.error(`Retry pass failed: ${error.message}`);
    } finally {
      this.running = false;
    }

    return { leads, updates };
  }

  /** @private */
  async retryLeads() {
    const pending = repo.leads.pending(BATCH_SIZE);
    let handled = 0;

    for (const lead of pending) {
      // Exponential backoff between attempts, so a persistent outage is not
      // hammered once a minute for eight straight minutes.
      if (!dueForRetry(lead)) continue;

      const group = lead.group_id
        ? repo.groups.all().find((g) => g.id === lead.group_id)
        : null;

      // No rawMessage: we cannot quote a message we no longer hold in memory, and
      // a retry has already been announced once (S6).
      await this.orchestrator.pushLead(lead, null, group, undefined);
      handled += 1;
    }

    return handled;
  }

  /** @private */
  async retryUpdates() {
    const pending = repo.leadUpdates.pending(BATCH_SIZE);
    let handled = 0;

    for (const record of pending) {
      if (!dueForRetry(record)) continue;

      const parent = repo.leads.byId(record.lead_id);
      if (!parent?.crm_lead_id) continue; // parent still not in the CRM

      const parsed = labelParser.parse(record.body);
      const remarkParts = [
        ...parsed.plain,
        ...parsed.rejected.map((r) => `${r.label}: ${r.value}`)
      ];

      await this.orchestrator.applyUpdate(record, parent, parsed, remarkParts, null, undefined);
      handled += 1;
    }

    return handled;
  }

  /**
   * Bank shares and bank-group messages that have not reached the CRM.
   * @private
   */
  async retryBankWork() {
    let handled = 0;

    for (const share of repo.bankShares.pending(BATCH_SIZE)) {
      if (!dueForRetry(share)) continue;
      const group = share.group_id
        ? repo.groups.all().find((g) => g.id === share.group_id)
        : null;
      await this.orchestrator.bank.pushShare(share, group);
      handled += 1;
    }

    for (const record of repo.bankMessages.pending(BATCH_SIZE)) {
      if (!dueForRetry(record)) continue;
      await this.orchestrator.bank.pushMessage(record);
      handled += 1;
    }

    return handled;
  }
}

/**
 * Whether enough time has passed since the last attempt.
 * Backoff doubles each time: 1, 2, 4, 8… minutes, capped at an hour.
 *
 * @param {{ attempts: number, updated_at?: string, created_at: string }} row
 * @returns {boolean}
 */
function dueForRetry(row) {
  if (!row.attempts) return true;

  const waitMs = Math.min(60_000 * 2 ** (row.attempts - 1), 3_600_000);
  const last = Date.parse(`${(row.updated_at || row.created_at).replace(' ', 'T')}Z`);
  if (Number.isNaN(last)) return true;

  return Date.now() - last >= waitMs;
}

module.exports = { RetryWorker, dueForRetry };
