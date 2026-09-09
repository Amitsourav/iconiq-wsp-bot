/**
 * CRM HTTP client.
 *
 * Every constraint from docs/CRM-INTEGRATION.md is enforced here rather than at the
 * call sites, so a caller cannot accidentally bypass one:
 *
 *   C10  unknown keys are silently ignored on create — a 201 is not proof the data
 *        landed, so payloads are validated against the accepted-field list first
 *   C11  loan_amount and bank_name are update-only — create then patch
 *   C12  over-length input returns 500, not 422 — truncate before sending
 *   C13  assigned_agent_id is unvalidated — a bad UUID 500s at the FK
 *   B2   duplicates return existing_lead_id, so "already exists" becomes
 *        "update that one" in a single hop
 *
 * The client never issues DELETE. The CRM blocks it at the middleware anyway, but
 * we do not rely on their guard to enforce our own rule.
 */
const { config } = require('../config');
const logger = require('../logger');
const {
  CREATE_FIELDS, UPDATE_FIELDS, NEVER_SEND, UPDATE_FORBIDDEN, MAX_LENGTH,
  UPDATE_ONLY_FIELDS
} = require('./fields');

/** Retry only on transport failures and 5xx. A 4xx means the request was wrong. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;

/**
 * The CRM's database is in Korea and routinely takes 2–20s per request. A short
 * timeout would turn ordinary slowness into a retry storm, and for a non-idempotent
 * POST that means duplicates.
 */
const REQUEST_TIMEOUT_MS = 45_000;

/** Stages where a lead is finished. A remark here lands on a record nobody watches. */
const TERMINAL_STAGES = new Set(['disbursed', 'lost', 'enrolled']);

class CrmError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

/**
 * A create that collided with an existing lead. Carries the existing lead's id so
 * the caller can switch to updating it without a search (B2).
 */
class DuplicateLeadError extends CrmError {
  constructor(body) {
    super(body?.detail || 'Duplicate lead', { status: 400, body });
    this.name = 'DuplicateLeadError';
    this.existingLeadId = body?.existing_lead_id || null;
    this.existingLeadName = body?.existing_lead_name || null;
    this.duplicateField = body?.duplicate_field || null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CrmClient {
  /**
   * @param {{ baseUrl?: string, apiKey?: string, fetchImpl?: Function }} [options]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || config.crm.baseUrl || '').replace(/\/$/, '');
    this.apiKey = options.apiKey || config.crm.apiKey;
    this.fetch = options.fetchImpl || globalThis.fetch;
    /** @type {Map<string, object>|null} profile id → user, populated by loadUsers() */
    this.users = null;
  }

  get configured() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  /**
   * Issue a request, retrying transport failures and 5xx with exponential backoff.
   *
   * `options.timeoutMs` overrides the default per-attempt timeout. The reporting
   * endpoints need it: they sit at 40-45s against a 45s default, so a call that
   * normally succeeds randomly tips over and retries at full cost.
   *
   * @private
   */
  async request(method, path, body, options = {}) {
    if (method === 'DELETE') {
      // Our own rule, enforced before the CRM's middleware ever sees it.
      throw new CrmError('The integration never issues DELETE');
    }
    if (!this.configured) {
      throw new CrmError('CRM is not configured — set CRM_BASE_URL and CRM_API_KEY');
    }

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response;
      try {
        response = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'X-API-Key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS)
        });
      } catch (error) {
        // Network-level failure. We cannot tell whether the server processed it,
        // so the caller must have recorded the attempt before calling us.
        lastError = new CrmError(`Network error: ${error.message}`, { retryable: true });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      }

      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { detail: text.slice(0, 500) };
        }
      }

      if (response.ok) return payload;

      if (payload?.error_code === 'duplicate_lead') {
        throw new DuplicateLeadError(payload);
      }

      const retryable = RETRY_STATUS.has(response.status);
      lastError = new CrmError(
        `${method} ${path} → ${response.status}: ${payload?.detail || 'no detail'}`,
        { status: response.status, body: payload, retryable }
      );

      if (retryable && attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(`CRM ${response.status} on ${path}, retrying in ${delay}ms (attempt ${attempt})`);
        await sleep(delay);
        continue;
      }

      throw lastError;
    }

    throw lastError;
  }

  /**
   * Strip anything the CRM would reject, ignore, or 500 on.
   *
   * @param {Object} input
   * @param {'create'|'update'} mode
   * @returns {{ payload: Object, dropped: {field: string, reason: string}[] }}
   */
  sanitise(input, mode) {
    const allowed = mode === 'create' ? CREATE_FIELDS : UPDATE_FIELDS;
    const payload = {};
    const dropped = [];

    for (const [field, value] of Object.entries(input || {})) {
      if (value === undefined || value === null) continue;

      if (NEVER_SEND.has(field)) {
        dropped.push({ field, reason: 'never_send' });
        continue;
      }

      // phone is required on create (it is what deduplicates) but must never be
      // patched afterwards — C3.
      if (mode === 'update' && UPDATE_FORBIDDEN.has(field)) {
        dropped.push({ field, reason: 'update_forbidden' });
        continue;
      }

      if (!allowed.has(field)) {
        // C10 — the CRM would accept this with a 201 and silently discard it.
        dropped.push({
          field,
          reason: mode === 'create' && UPDATE_ONLY_FIELDS.has(field)
            ? 'update_only'
            : 'not_accepted'
        });
        continue;
      }

      const max = MAX_LENGTH[field];
      payload[field] = (max && typeof value === 'string') ? value.slice(0, max) : value;
    }

    return { payload, dropped };
  }

  /**
   * Confirm the key resolves to the tenant we expect, before any write.
   *
   * The same email can exist in both tenants with different profile ids, so an id
   * carried between environments points at a different person. This is the cheap
   * check that catches a mis-set key before it writes to the wrong company.
   *
   * @returns {Promise<object>} the service account
   * @throws if the tenant does not match config.crm.expectedCompanyId
   */
  async verifyTenant() {
    const me = await this.whoami();
    const expected = config.crm.expectedCompanyId;

    if (expected && me.company_id !== expected) {
      throw new CrmError(
        `Wrong CRM tenant. The key belongs to "${me.company_name}" (${me.company_id}) `
        + `but CRM_EXPECTED_COMPANY_ID is ${expected}. Refusing to write.`
      );
    }

    this.identity = me;
    return me;
  }

  /**
   * List leads, following pagination.
   *
   * Verified against the live API: `date_from` and `current_stage` filter;
   * `limit`, `assigned_agent_id` and `created_after` are silently ignored, so
   * anything else must be filtered on our side. Default page size is 25.
   *
   * @param {Object} [filters] - e.g. { date_from: '2026-08-06', current_stage: 'created' }
   * @param {number} [maxPages] - a stop, so a bad filter cannot walk 10,000 leads
   * @returns {Promise<object[]>}
   */
  async listLeads(filters = {}, maxPages = 20) {
    const collected = [];
    let page = 1;

    while (page <= maxPages) {
      const query = new URLSearchParams({ ...filters, page: String(page), page_size: '100' });
      const result = await this.request('GET', `/leads?${query}`);
      const rows = result?.items || [];
      collected.push(...rows);

      const totalPages = result?.total_pages ?? 1;
      if (page >= totalPages || rows.length === 0) break;
      page += 1;
    }

    if (page > maxPages) {
      // Silent truncation would read as "this is everything".
      logger.warn(`listLeads stopped at ${maxPages} pages — results are incomplete`);
    }

    return collected;
  }

  /**
   * Find a lead by phone number.
   *
   * Search is substring ILIKE, not exact, and can return several rows (C5). A full
   * ten-digit number is a precise enough needle in practice, but more than one
   * match is treated as ambiguous rather than guessed at.
   *
   * @param {string} phone - E.164
   * @returns {Promise<object|null>} the single match, or null if none or ambiguous
   */
  async findByPhone(phone) {
    if (!phone) return { status: 'none', lead: null };

    const national = String(phone).replace(/^\+91/, '');

    // Deliberately NOT caught. A failed search is not the same as "no such lead",
    // and treating it as one would have the bot announce that a real lead does
    // not exist every time the CRM was slow. The caller retries instead.
    const result = await this.request(
      'GET', `/leads/search?q=${encodeURIComponent(national)}`
    );

    const rows = Array.isArray(result) ? result : (result.items || result.leads || []);
    const exact = rows.filter((r) => {
      const stored = String(r.phone || '').replace(/\D/g, '');
      return stored.endsWith(national);
    });

    if (exact.length === 1) return { status: 'found', lead: exact[0] };

    // More than one lead carries this number — the CRM allows that, and their own
    // report confirmed edits can create it. Guessing between them is worse than
    // saying we could not tell.
    if (exact.length > 1) {
      return { status: 'ambiguous', lead: null, candidates: exact.length };
    }

    return { status: 'none', lead: null };
  }

  /**
   * Read a lead.
   * @param {string} leadId
   * @returns {Promise<object>}
   */
  async getLead(leadId) {
    return this.request('GET', `/leads/${leadId}`);
  }

  /**
   * Whether a lead is finished, so a remark would land where nobody is looking.
   * @param {object} lead
   * @returns {boolean}
   */
  static isTerminal(lead) {
    return TERMINAL_STAGES.has(lead?.current_stage);
  }

  /**
   * Load the CRM user list and cache it.
   * Needed to validate assigned_agent_id before sending (C13).
   * @returns {Promise<object[]>}
   */
  async loadUsers() {
    const list = await this.request('GET', '/users');
    this.users = new Map(list.map((u) => [u.id, u]));
    logger.info(`Loaded ${this.users.size} CRM users`);
    return list;
  }

  /**
   * @param {string} profileId
   * @returns {boolean}
   */
  isKnownUser(profileId) {
    if (!this.users) throw new CrmError('User list not loaded — call loadUsers() first');
    return this.users.has(profileId);
  }

  /**
   * Create a lead.
   *
   * Fields that are update-only are returned in `deferred` rather than dropped, so
   * the caller can patch them immediately afterwards (C11).
   *
   * @param {Object} fields
   * @returns {Promise<{ lead: Object, deferred: Object, dropped: Array }>}
   * @throws {DuplicateLeadError} carrying existingLeadId
   */
  async createLead(fields) {
    if (!fields.full_name) throw new CrmError('full_name is required');

    if (fields.assigned_agent_id && this.users && !this.isKnownUser(fields.assigned_agent_id)) {
      // The cache is loaded once at startup, so a colleague added to the CRM
      // since then reads as invalid. Refresh before rejecting: on 3 Sep 2026 a
      // new counsellor was mapped correctly and every lead tagged to her failed
      // all eight attempts against a stale list, with nothing wrong but this.
      logger.warn(`Unknown agent ${fields.assigned_agent_id} — refreshing the user list`);
      await this.loadUsers().catch((error) =>
        logger.warn(`User list refresh failed: ${error.message}`));

      // C13 — a genuinely unknown UUID 500s at the foreign key, which is
      // indistinguishable from a real outage to a retry loop. Still refused.
      if (!this.isKnownUser(fields.assigned_agent_id)) {
        throw new CrmError(`Unknown assigned_agent_id: ${fields.assigned_agent_id}`);
      }
    }

    // The CRM requires a source on every create (added 2026-09-07: "A lead source
    // is required... without it the lead is invisible to every channel report").
    // Set here rather than at the call sites so no path can forget it.
    const withSource = fields.lead_source_id
      ? fields
      : { ...fields, lead_source_id: config.crm.leadSourceId };

    const { payload, dropped } = this.sanitise(withSource, 'create');

    // Keep update-only values for the follow-up patch instead of losing them.
    const deferred = {};
    for (const { field, reason } of dropped) {
      if (reason === 'update_only') deferred[field] = fields[field];
    }

    const lead = await this.request('POST', '/leads', payload);

    if (!lead?.id) {
      // Without an id we cannot link the WhatsApp thread to the record, which
      // breaks every follow-up update.
      throw new CrmError('Create succeeded but returned no id', { body: lead });
    }

    return { lead, deferred, dropped: dropped.filter((d) => d.reason !== 'update_only') };
  }

  /**
   * Partially update a lead. PUT is a genuine patch (exclude_unset=True).
   * @param {string} leadId
   * @param {Object} fields
   * @returns {Promise<{ lead: Object, dropped: Array }>}
   */
  async updateLead(leadId, fields) {
    const { payload, dropped } = this.sanitise(fields, 'update');
    if (Object.keys(payload).length === 0) {
      return { lead: null, dropped };
    }
    const lead = await this.request('PUT', `/leads/${leadId}`, payload);
    return { lead, dropped };
  }

  /**
   * Append a remark. This is the ONLY way we write notes — `lead.notes` is
   * destructive and shared with the AI call pipeline (C1).
   *
   * @param {string} leadId
   * @param {string} text - what a person will read; nothing else belongs here
   * @param {string} [sourceId] - the originating WhatsApp message id, sent as a
   *   field so a retry duplicate stays traceable without cluttering the note
   * @returns {Promise<Object>}
   */
  async addRemark(leadId, text, sourceId) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new CrmError('Remark text is empty');

    // The message id is sent as a field, never inside the body. It used to be
    // appended as "[wa:…]" so a retry duplicate could be spotted, but that put
    // machine bookkeeping into text counsellors read all day — and truncation
    // ran after stamping, so the longest notes lost the stamp anyway.
    //
    // The CRM ignores unknown keys (C10), so this is inert until they add the
    // column and starts working the moment they do. addBankMessage already sends
    // wa_message_id this way, and that endpoint is idempotent on it.
    return this.request('POST', `/leads/${leadId}/remarks`, {
      // Their validation is 1–5000 with a clean 422; truncate rather than fail.
      body: trimmed.slice(0, 5000),
      wa_message_id: sourceId || undefined
    });
  }

  /**
   * Record that a lead was shared into a bank's WhatsApp group.
   *
   * Idempotent on (lead, bank): sharing the same lead to the same bank again
   * keeps the original shared_at and does not create a second row.
   *
   * @param {string} leadId
   * @param {{ bankName: string, sharedBy?: string, sharedAt?: string,
   *           waGroupId?: string }} share
   * @returns {Promise<Object>}
   */
  async recordBankShare(leadId, { bankName, sharedBy, sharedAt, waGroupId }) {
    return this.request('POST', `/leads/${leadId}/bank-shares`, {
      bank_name: bankName,
      shared_by: sharedBy || undefined,
      shared_at: sharedAt || undefined,
      wa_group_id: waGroupId || undefined,
      source: 'whatsapp'
    });
  }

  /**
   * Append a message to the conversation about a lead in a bank's group.
   *
   * Idempotent on wa_message_id, which is what makes replaying a message after a
   * reconnect harmless.
   *
   * @param {string} leadId
   * @param {string} bankName
   * @param {{ body: string, senderPhone?: string, senderName?: string,
   *           isOurTeam?: boolean, waMessageId: string }} message
   * @returns {Promise<Object>}
   */
  async addBankMessage(leadId, bankName, message) {
    const body = String(message.body || '').trim();
    if (!body) throw new CrmError('Bank message body is empty');

    return this.request('POST',
      `/leads/${leadId}/bank-shares/${encodeURIComponent(bankName)}/messages`, {
        body: body.slice(0, 5000),
        sender_phone: message.senderPhone || undefined,
        sender_name: message.senderName || undefined,
        is_our_team: Boolean(message.isOurTeam),
        wa_message_id: message.waMessageId
      });
  }

  /**
   * One person's daily metrics over the last N days, newest last.
   *
   * The single-day report would mean one call per person per day — 31 days times
   * four counsellors is 124 requests against a CRM that routinely takes seconds
   * per call. This returns the whole stretch in one.
   *
   * Verified against the live API: `days=24` on the 24th returned rows dated the
   * 1st to the 24th inclusive. That boundary is not documented anywhere, so
   * callers must still filter by date rather than trust it (see buildLoanMis).
   *
   * @param {string} userId - CRM profile id
   * @param {number} days
   * @returns {Promise<{date: string, leads_created: number,
   *   transitions_by_stage: Object<string, number>}[]>}
   */
  async userDailyRange(userId, days) {
    // 120s, not the default 45s. Measured at 40-45s per call, so the default left
    // no margin: a normal call would occasionally exceed it and retry, and one
    // such retry storm cost 330s and still came back empty.
    const rows = await this.request(
      'GET', `/reports/daily/range?user_id=${encodeURIComponent(userId)}&days=${days}`,
      undefined, { timeoutMs: 120_000 }
    );
    return Array.isArray(rows) ? rows : [];
  }

  /** @returns {Promise<Object>} the authenticated service account */
  async whoami() {
    return this.request('GET', '/users/me');
  }
}

module.exports = { CrmClient, CrmError, DuplicateLeadError };
