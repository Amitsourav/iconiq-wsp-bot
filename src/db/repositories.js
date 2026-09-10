/**
 * Data access. All SQL lives here — nothing else in the codebase writes queries.
 */
const { get } = require('./index');

/** Groups we monitor. */
const groups = {
  /** Insert or refresh a group's cached name. Does not change its active flag. */
  upsert(waGroupId, name) {
    get().prepare(`
      INSERT INTO groups (wa_group_id, name) VALUES (?, ?)
      ON CONFLICT(wa_group_id) DO UPDATE SET
        name = excluded.name,
        updated_at = datetime('now')
    `).run(waGroupId, name);
    return this.byWaId(waGroupId);
  },

  byWaId(waGroupId) {
    return get().prepare('SELECT * FROM groups WHERE wa_group_id = ?').get(waGroupId) || null;
  },

  all() {
    return get().prepare('SELECT * FROM groups ORDER BY is_active DESC, name').all();
  },

  active() {
    return get().prepare('SELECT * FROM groups WHERE is_active = 1').all();
  },

  setActive(id, isActive) {
    get().prepare("UPDATE groups SET is_active = ?, updated_at = datetime('now') WHERE id = ?")
      .run(isActive ? 1 : 0, id);
  },

  /**
   * Enable or disable sending for a group (S5).
   * Bank groups can never send, whatever is requested — they are not ours.
   */
  setSendEnabled(id, enabled) {
    get().prepare(`
      UPDATE groups
      SET send_enabled = CASE WHEN purpose = 'bank' THEN 0 ELSE ? END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(enabled ? 1 : 0, id);
  },

  /**
   * Remember the newest message seen in a group — the point to replay from after
   * a gap.
   */
  setWatermark(waGroupId, { id, timestamp, fromMe }) {
    get().prepare(`
      UPDATE groups
      SET last_message_id = ?, last_message_ts = ?, last_message_from_me = ?,
          last_seen_at = datetime('now')
      WHERE wa_group_id = ?
        AND (last_message_ts IS NULL OR last_message_ts <= ?)
    `).run(id, timestamp, fromMe ? 1 : 0, waGroupId, timestamp);
  },

  /** Which bank a group represents. Must match the CRM's list exactly. */
  setBank(id, bankName) {
    get().prepare("UPDATE groups SET bank_name = ?, updated_at = datetime('now') WHERE id = ?")
      .run(bankName || null, id);
  },

  setPurpose(id, purpose) {
    get().prepare(`
      UPDATE groups
      SET purpose = ?,
          send_enabled = CASE WHEN ? = 'bank' THEN 0 ELSE send_enabled END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(purpose, purpose, id);
  }
};

/** WhatsApp number → CRM user (C9 — hand-maintained). */
const employees = {
  upsert({ waPhone, crmProfileId, name, email }) {
    get().prepare(`
      INSERT INTO employees (wa_phone, crm_profile_id, name, email) VALUES (?, ?, ?, ?)
      ON CONFLICT(wa_phone) DO UPDATE SET
        crm_profile_id = excluded.crm_profile_id,
        name = excluded.name,
        email = excluded.email,
        updated_at = datetime('now')
    `).run(waPhone, crmProfileId, name, email || null);
    return this.byPhone(waPhone);
  },

  byPhone(waPhone) {
    return get().prepare('SELECT * FROM employees WHERE wa_phone = ? AND is_active = 1')
      .get(waPhone) || null;
  },

  all() {
    return get().prepare('SELECT * FROM employees ORDER BY name').all();
  },

  remove(id) {
    get().prepare('DELETE FROM employees WHERE id = ?').run(id);
  }
};

/** Leads captured from WhatsApp. */
const leads = {
  /**
   * Record a lead BEFORE the CRM is called.
   *
   * Returns null if this message was already recorded — WhatsApp redelivers after
   * a reconnect, and this is what makes reprocessing a no-op rather than a
   * duplicate lead.
   */
  create(row) {
    const result = get().prepare(`
      INSERT OR IGNORE INTO leads
        (wa_message_id, group_id, name, phone, sender_phone, raw_message,
         mentioned_phone, employee_id, status, held_reason)
      VALUES (@waMessageId, @groupId, @name, @phone, @senderPhone, @rawMessage,
              @mentionedPhone, @employeeId, @status, @heldReason)
    `).run({
      heldReason: null, employeeId: null, mentionedPhone: null,
      name: null, phone: null, senderPhone: null, groupId: null,
      status: 'pending', ...row
    });

    return result.changes === 0 ? null : this.byId(result.lastInsertRowid);
  },

  byId(id) {
    return get().prepare('SELECT * FROM leads WHERE id = ?').get(id) || null;
  },

  byWaMessageId(waMessageId) {
    return get().prepare('SELECT * FROM leads WHERE wa_message_id = ?').get(waMessageId) || null;
  },

  markCreated(id, crmLeadId) {
    get().prepare(`
      UPDATE leads SET status = 'created', crm_lead_id = ?, last_error = NULL,
                       updated_at = datetime('now')
      WHERE id = ?
    `).run(crmLeadId, id);
  },

  /** The phone already existed in the CRM (Q5). Assignment is deliberately untouched. */
  markExisting(id, crmLeadId) {
    get().prepare(`
      UPDATE leads SET status = 'existing', crm_lead_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(crmLeadId, id);
  },

  /** Waiting on a human — no mention, unknown mention, or several (Q6/Q9). */
  markHeld(id, reason) {
    get().prepare(`
      UPDATE leads SET status = 'held', held_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(reason, id);
  },

  markFailed(id, error) {
    get().prepare(`
      UPDATE leads SET status = 'failed', last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(String(error).slice(0, 1000), id);
  },

  /** Count an attempt. Called once before each CRM call, so a crash mid-flight
   *  still counts and cannot retry forever. */
  recordAttempt(id) {
    get().prepare(`
      UPDATE leads SET attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?
    `).run(id);
  },

  /** Record why an attempt failed, without counting it twice. */
  recordError(id, error) {
    get().prepare(`
      UPDATE leads SET last_error = ?, updated_at = datetime('now') WHERE id = ?
    `).run(String(error).slice(0, 1000), id);
  },

  markReplied(id) {
    get().prepare('UPDATE leads SET replied = 1 WHERE id = ?').run(id);
  },

  /** Leads still owed a CRM write. Ordered oldest first so nothing starves. */
  pending(limit = 20) {
    return get().prepare(`
      SELECT * FROM leads
      WHERE status = 'pending' AND attempts < 8
      ORDER BY created_at ASC LIMIT ?
    `).all(limit);
  },

  held() {
    return get().prepare(`
      SELECT l.*, g.name AS group_name
      FROM leads l LEFT JOIN groups g ON g.id = l.group_id
      WHERE l.status = 'held' ORDER BY l.created_at DESC
    `).all();
  },

  recent(limit = 50) {
    return get().prepare(`
      SELECT l.*, g.name AS group_name, e.name AS employee_name
      FROM leads l
      LEFT JOIN groups g ON g.id = l.group_id
      LEFT JOIN employees e ON e.id = l.employee_id
      ORDER BY l.created_at DESC LIMIT ?
    `).all(limit);
  },

  assign(id, employeeId, mentionedPhone) {
    get().prepare(`
      UPDATE leads SET employee_id = ?, mentioned_phone = ?, status = 'pending',
                       held_reason = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(employeeId, mentionedPhone, id);
  }
};

/** Field updates and remarks arriving as replies. */
const leadUpdates = {
  create(row) {
    const result = get().prepare(`
      INSERT OR IGNORE INTO lead_updates
        (wa_message_id, lead_id, kind, payload, body, sender_phone)
      VALUES (@waMessageId, @leadId, @kind, @payload, @body, @senderPhone)
    `).run({ senderPhone: null, ...row });

    return result.changes === 0 ? null : this.byId(result.lastInsertRowid);
  },

  byId(id) {
    return get().prepare('SELECT * FROM lead_updates WHERE id = ?').get(id) || null;
  },

  markApplied(id) {
    get().prepare("UPDATE lead_updates SET status = 'applied' WHERE id = ?").run(id);
  },

  markFailed(id, error) {
    get().prepare(`
      UPDATE lead_updates SET status = 'failed', last_error = ? WHERE id = ?
    `).run(String(error).slice(0, 1000), id);
  },

  recordAttempt(id) {
    get().prepare('UPDATE lead_updates SET attempts = attempts + 1 WHERE id = ?').run(id);
  },

  recordError(id, error) {
    get().prepare('UPDATE lead_updates SET last_error = ? WHERE id = ?')
      .run(String(error).slice(0, 1000), id);
  },

  markReplied(id) {
    get().prepare('UPDATE lead_updates SET replied = 1 WHERE id = ?').run(id);
  },

  pending(limit = 20) {
    return get().prepare(`
      SELECT u.*, l.crm_lead_id
      FROM lead_updates u JOIN leads l ON l.id = u.lead_id
      WHERE u.status = 'pending' AND u.attempts < 8 AND l.crm_lead_id IS NOT NULL
      ORDER BY u.created_at ASC LIMIT ?
    `).all(limit);
  }
};

/** Messages that produced nothing, kept with a reason. */
const skipped = {
  /**
   * @returns {boolean} true if this message had not been recorded before.
   *   WhatsApp redelivers after a reconnect, and a reply must not be sent twice
   *   for the same message (S2).
   */
  record({ waMessageId, groupId, body, reason, senderPhone }) {
    const result = get().prepare(`
      INSERT OR IGNORE INTO skipped_messages
        (wa_message_id, group_id, body, reason, sender_phone)
      VALUES (?, ?, ?, ?, ?)
    `).run(waMessageId, groupId || null, body || '', reason, senderPhone || null);
    return result.changes > 0;
  },

  recent(limit = 100) {
    return get().prepare(`
      SELECT s.*, g.name AS group_name
      FROM skipped_messages s LEFT JOIN groups g ON g.id = s.group_id
      ORDER BY s.created_at DESC LIMIT ?
    `).all(limit);
  },

  /** Counts by reason — the fastest way to spot a parser gap. */
  reasonCounts() {
    return get().prepare(`
      SELECT reason, COUNT(*) AS count FROM skipped_messages
      GROUP BY reason ORDER BY count DESC
    `).all();
  }
};

/** Leads seen shared into a bank's group. */
const bankShares = {
  create(row) {
    const result = get().prepare(`
      INSERT OR IGNORE INTO bank_shares
        (wa_message_id, group_id, bank_name, phone, crm_lead_id, sender_phone,
         employee_id, raw_message, status)
      VALUES (@waMessageId, @groupId, @bankName, @phone, @crmLeadId, @senderPhone,
              @employeeId, @rawMessage, @status)
    `).run({
      crmLeadId: null, senderPhone: null, employeeId: null,
      status: 'pending', ...row
    });
    return result.changes === 0 ? null : this.byId(result.lastInsertRowid);
  },

  byId(id) {
    return get().prepare('SELECT * FROM bank_shares WHERE id = ?').get(id) || null;
  },

  byWaMessageId(waMessageId) {
    return get().prepare('SELECT * FROM bank_shares WHERE wa_message_id = ?')
      .get(waMessageId) || null;
  },

  /** The most recent share of this phone into this bank, for attaching replies. */
  latestFor(phone, bankName) {
    return get().prepare(`
      SELECT * FROM bank_shares
      WHERE phone = ? AND bank_name = ? AND crm_lead_id IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).get(phone, bankName) || null;
  },

  markRecorded(id, crmLeadId) {
    get().prepare(`
      UPDATE bank_shares SET status = 'recorded', crm_lead_id = ?, last_error = NULL,
                             updated_at = datetime('now')
      WHERE id = ?
    `).run(crmLeadId, id);
  },

  /** The phone is not a lead in the CRM — the team is told once. */
  markUnknown(id) {
    get().prepare(`
      UPDATE bank_shares SET status = 'unknown', updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
  },

  markFailed(id, error) {
    get().prepare(`
      UPDATE bank_shares SET status = 'failed', last_error = ?,
                             updated_at = datetime('now')
      WHERE id = ?
    `).run(String(error).slice(0, 1000), id);
  },

  recordAttempt(id) {
    get().prepare(`
      UPDATE bank_shares SET attempts = attempts + 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
  },

  recordError(id, error) {
    get().prepare('UPDATE bank_shares SET last_error = ? WHERE id = ?')
      .run(String(error).slice(0, 1000), id);
  },

  markNotified(id) {
    get().prepare('UPDATE bank_shares SET notified = 1 WHERE id = ?').run(id);
  },

  pending(limit = 20) {
    return get().prepare(`
      SELECT * FROM bank_shares WHERE status = 'pending' AND attempts < 8
      ORDER BY created_at ASC LIMIT ?
    `).all(limit);
  },

  recent(limit = 50) {
    return get().prepare(`
      SELECT b.*, g.name AS group_name, e.name AS employee_name
      FROM bank_shares b
      LEFT JOIN groups g ON g.id = b.group_id
      LEFT JOIN employees e ON e.id = b.employee_id
      ORDER BY b.created_at DESC LIMIT ?
    `).all(limit);
  }
};

/** Conversation about a lead inside a bank's group. */
const bankMessages = {
  create(row) {
    const result = get().prepare(`
      INSERT OR IGNORE INTO bank_messages
        (wa_message_id, group_id, bank_name, crm_lead_id, body, sender_phone, is_our_team)
      VALUES (@waMessageId, @groupId, @bankName, @crmLeadId, @body, @senderPhone, @isOurTeam)
    `).run({ senderPhone: null, isOurTeam: 0, ...row });
    return result.changes === 0 ? null : this.byId(result.lastInsertRowid);
  },

  byId(id) {
    return get().prepare('SELECT * FROM bank_messages WHERE id = ?').get(id) || null;
  },

  markApplied(id) {
    get().prepare("UPDATE bank_messages SET status = 'applied' WHERE id = ?").run(id);
  },

  markFailed(id, error) {
    get().prepare("UPDATE bank_messages SET status = 'failed', last_error = ? WHERE id = ?")
      .run(String(error).slice(0, 1000), id);
  },

  recordAttempt(id) {
    get().prepare('UPDATE bank_messages SET attempts = attempts + 1 WHERE id = ?').run(id);
  },

  recordError(id, error) {
    get().prepare('UPDATE bank_messages SET last_error = ? WHERE id = ?')
      .run(String(error).slice(0, 1000), id);
  },

  pending(limit = 20) {
    return get().prepare(`
      SELECT * FROM bank_messages WHERE status = 'pending' AND attempts < 8
      ORDER BY created_at ASC LIMIT ?
    `).all(limit);
  }
};

/**
 * One row per DM chat (the customer's JID) — the CRM link and what we know
 * about them. See dm_messages below for the actual conversation.
 */
const dmThreads = {
  byChatId(chatId) {
    return get().prepare('SELECT * FROM dm_threads WHERE chat_id = ?').get(chatId) || null;
  },

  /** Create the thread on first contact if it doesn't exist yet; never overwrites. */
  upsert(chatId, phone) {
    get().prepare(`
      INSERT INTO dm_threads (chat_id, phone) VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        phone = COALESCE(dm_threads.phone, excluded.phone),
        updated_at = datetime('now')
    `).run(chatId, phone || null);
    return this.byChatId(chatId);
  },

  /**
   * Set the name we know this person by. Overwrites — used for a name they
   * actually stated, which outranks anything we guessed or read off a profile.
   */
  setName(chatId, name) {
    if (!name) return;
    get().prepare(`
      UPDATE dm_threads SET name = ?, updated_at = datetime('now') WHERE chat_id = ?
    `).run(name, chatId);
  },

  /**
   * Fill the name only if we have none.
   *
   * For a WhatsApp profile name, which is whatever the person set for
   * themselves. Better than calling a lead by its phone number, but it must
   * never displace a name they gave us in conversation — and their profile name
   * arrives on every message, so an overwriting version would undo the good
   * name on the very next one.
   *
   * @returns {boolean} whether this is what filled it in
   */
  setNameIfBlank(chatId, name) {
    if (!name) return false;
    const result = get().prepare(`
      UPDATE dm_threads SET name = ?, updated_at = datetime('now')
      WHERE chat_id = ? AND (name IS NULL OR name = '')
    `).run(name, chatId);
    return result.changes > 0;
  },

  setCrmLead(chatId, crmLeadId) {
    get().prepare(`
      UPDATE dm_threads SET crm_lead_id = ?, updated_at = datetime('now') WHERE chat_id = ?
    `).run(crmLeadId, chatId);
  },

  markSynced(chatId) {
    get().prepare(`
      UPDATE dm_threads SET status = 'synced', last_error = NULL, updated_at = datetime('now')
      WHERE chat_id = ?
    `).run(chatId);
  },

  markAmbiguous(chatId, reason) {
    get().prepare(`
      UPDATE dm_threads SET status = 'ambiguous', last_error = ?, updated_at = datetime('now')
      WHERE chat_id = ?
    `).run(String(reason).slice(0, 1000), chatId);
  },

  markFailed(chatId, error) {
    get().prepare(`
      UPDATE dm_threads SET status = 'failed', last_error = ?, updated_at = datetime('now')
      WHERE chat_id = ?
    `).run(String(error).slice(0, 1000), chatId);
  },

  /**
   * Record a phone number discovered after the chat had already started.
   *
   * WhatsApp does not always send the real number with the first message of a
   * LID-addressed chat, but it usually sends it with a later one. Only ever
   * fills a blank — a number already recorded is the identity of the lead and
   * is never rewritten (C3).
   *
   * @returns {boolean} whether this call is what filled it in
   */
  setPhone(chatId, phone) {
    if (!phone) return false;
    const result = get().prepare(`
      UPDATE dm_threads SET phone = ?, updated_at = datetime('now')
      WHERE chat_id = ? AND phone IS NULL
    `).run(phone, chatId);
    return result.changes > 0;
  },

  /**
   * Chats we are talking to but cannot identify.
   *
   * The bot answers these perfectly — the customer has a normal conversation —
   * but WhatsApp has given us no phone number for them, so no lead can be
   * created. Without somewhere to show them they are a customer nobody in the
   * CRM knows exists, which is worse than a visible failure.
   */
  unidentified(limit = 50) {
    return get().prepare(`
      SELECT t.*,
             (SELECT COUNT(*) FROM dm_messages m WHERE m.chat_id = t.chat_id)
               AS message_count,
             (SELECT m.body FROM dm_messages m
               WHERE m.chat_id = t.chat_id AND m.direction = 'in'
               ORDER BY m.id DESC LIMIT 1) AS last_inbound
      FROM dm_threads t
      WHERE t.phone IS NULL
      ORDER BY t.updated_at DESC
      LIMIT ?
    `).all(limit);
  },

  /** The CRM fields already written for this chat. */
  captured(chatId) {
    const row = this.byChatId(chatId);
    if (!row?.captured) return {};
    try {
      return JSON.parse(row.captured);
    } catch {
      // A corrupt value must not stop the conversation; treat it as nothing
      // captured yet. The worst case is one redundant write.
      return {};
    }
  },

  /** Merge newly written fields into the record of what the CRM already holds. */
  setCaptured(chatId, fields) {
    const merged = { ...this.captured(chatId), ...fields };
    get().prepare(`
      UPDATE dm_threads SET captured = ?, updated_at = datetime('now') WHERE chat_id = ?
    `).run(JSON.stringify(merged), chatId);
    return merged;
  },

  /** Count an attempt to create this chat's lead, for the retry backoff. */
  recordAttempt(chatId) {
    get().prepare(`
      UPDATE dm_threads
      SET attempts = attempts + 1, updated_at = datetime('now')
      WHERE chat_id = ?
    `).run(chatId);
  },

  /**
   * Chats that have no CRM lead yet and could still get one.
   *
   * `ambiguous` is excluded deliberately: that state means several leads carry
   * this number and a human has to decide which. Retrying would just guess
   * wrong once a minute. The nightly sync picks those up again, by which time
   * the records may have been merged.
   */
  awaitingLead(limit = 10) {
    return get().prepare(`
      SELECT * FROM dm_threads
      WHERE crm_lead_id IS NULL
        AND phone IS NOT NULL
        AND status != 'ambiguous'
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(limit);
  },

  recent(limit = 50) {
    return get().prepare(`
      SELECT * FROM dm_threads ORDER BY updated_at DESC LIMIT ?
    `).all(limit);
  }
};

/** Every message on a DM chat, both directions. */
const dmMessages = {
  create(row) {
    const result = get().prepare(`
      INSERT OR IGNORE INTO dm_messages (wa_message_id, chat_id, direction, body)
      VALUES (@waMessageId, @chatId, @direction, @body)
    `).run(row);
    return result.changes === 0 ? null : this.byId(result.lastInsertRowid);
  },

  byId(id) {
    return get().prepare('SELECT * FROM dm_messages WHERE id = ?').get(id) || null;
  },

  /** Distinct chats that have at least one message not yet synced to the CRM. */
  chatsWithUnsynced() {
    return get().prepare(`
      SELECT DISTINCT chat_id FROM dm_messages WHERE synced = 0
    `).all().map((r) => r.chat_id);
  },

  /**
   * The recent history of one chat, oldest last.
   *
   * Read from the database rather than the assistant's in-memory window so
   * extraction still sees the whole conversation after a restart — otherwise a
   * redeploy mid-chat would lose every detail the customer had already given.
   */
  recentForChat(chatId, limit = 40) {
    return get().prepare(`
      SELECT * FROM (
        SELECT * FROM dm_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(chatId, limit);
  },

  /** Unsynced messages for one chat, oldest first — the order they were sent in. */
  unsyncedForChat(chatId) {
    return get().prepare(`
      SELECT * FROM dm_messages WHERE chat_id = ? AND synced = 0 ORDER BY id ASC
    `).all(chatId);
  },

  markSynced(ids) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    get().prepare(`UPDATE dm_messages SET synced = 1 WHERE id IN (${placeholders})`).run(...ids);
  }
};

const settings = {
  get(key, fallback = null) {
    const row = get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  },

  set(key, value) {
    get().prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, String(value));
  },

  all() {
    return Object.fromEntries(
      get().prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])
    );
  }
};

const logs = {
  record(level, message, retain) {
    const db = get();
    db.prepare('INSERT INTO logs (level, message) VALUES (?, ?)').run(level, message);
    if (retain && Math.random() < 0.02) {
      db.prepare(`
        DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)
      `).run(retain);
    }
  },

  recent(limit = 200) {
    return get().prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit).reverse();
  }
};

module.exports = {
  groups, employees, leads, leadUpdates, bankShares, bankMessages,
  skipped, dmThreads, dmMessages, settings, logs
};
