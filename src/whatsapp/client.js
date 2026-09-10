/**
 * WhatsApp connection via Baileys.
 *
 * Baileys speaks WhatsApp's multi-device protocol directly rather than driving a
 * headless Chrome, which is why it needs ~100 MB instead of ~500 MB. Linking is
 * identical from the user's side: the same "Linked Devices" flow, either by QR or
 * by an 8-digit pairing code typed into the phone.
 *
 * The session lives in `.wwebjs_auth/` equivalent — see config.whatsapp.sessionPath.
 * Losing that folder means physically scanning again from the phone that owns the
 * number, so nothing here ever deletes it.
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const { config } = require('../config');
const logger = require('../logger');
const { normalise, toMentionJids } = require('./messages');
const { fromJid: phoneFromJid } = require('../pipeline/phone');

/**
 * Reconnect backoff.
 *
 * Kept short deliberately. A message that arrives while we are disconnected is
 * gone — WhatsApp does not replay it once the gap is long enough — so waiting
 * politely between attempts costs leads. A 15s ceiling means the worst case is a
 * 15-second hole rather than a minute.
 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

/** After this long connected, treat the next drop as a fresh incident. */
const STABLE_AFTER_MS = 60_000;

/**
 * Liveness watchdog.
 *
 * A Baileys socket can report "open" while silently receiving nothing — seen live
 * on 2026-08-06, when the bot sat "connected" for eleven minutes, missed a lead
 * entirely, and resumed the moment it was forced to reconnect. A clean disconnect
 * is recoverable; this is not, because nothing looks wrong.
 *
 * So the connection is probed rather than trusted.
 */
const WATCHDOG_INTERVAL_MS = 45_000;
const PROBE_TIMEOUT_MS = 15_000;
const FAILURES_BEFORE_RECONNECT = 2;

/** Sending guard (S3): a hard ceiling so a bug can never flood a group. */
/** Participant lists change rarely; one round trip per group per 10 minutes. */
const LID_CACHE_TTL_MS = 10 * 60_000;

const SEND_WINDOW_MS = 60_000;
const SEND_MAX_PER_WINDOW = 12;

class WhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.state = 'disconnected';
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.selfPhone = null;
    this.reconnectAttempts = 0;
    this.stopping = false;
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.sendTimestamps = [];
    /** Message IDs we sent ourselves, so we can ignore them (S1). */
    this.ownMessageIds = new Set();
    /** groupId -> { map: Map<lid, e164>, at: number } — see resolveLids(). */
    this.lidCache = new Map();
    this.watchdog = null;
    this.probeFailures = 0;
    /** Set while a history replay is in flight, so it is not requested twice. */
    this.recovering = false;
  }

  get connected() {
    return this.state === 'connected';
  }

  status() {
    return {
      state: this.state,
      connected: this.connected,
      selfPhone: this.selfPhone,
      qr: this.state === 'awaiting_scan' ? this.qrDataUrl : null,
      pairingCode: this.state === 'awaiting_scan' ? this.pairingCode : null
    };
  }

  /**
   * Connect, restoring the saved session if there is one.
   * @param {{ pairingPhone?: string }} [options] - request an 8-digit pairing code
   *   for this number instead of showing a QR. Digits only, with country code.
   */
  async connect(options = {}) {
    this.stopping = false;
    fs.mkdirSync(config.whatsapp.sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.sessionPath);

    // `registered` alone is not a reliable answer to "are we already linked?".
    // Baileys sets it during pairing-code registration but leaves it false for a
    // session linked by QR, so a perfectly good restored session reported no
    // session at all: the log said "link the number to continue" and the panel
    // showed a QR, three seconds before connecting normally. That invites
    // someone to scan again "to be safe" — which links a SECOND device, and two
    // devices on one number both answer every message.
    //
    // `me.id` is written once a number is linked and persists with the session,
    // so it answers the question both paths agree on.
    const hasSession = Boolean(state.creds?.me?.id || state.creds?.registered);

    this.sock = makeWASocket({
      auth: state,
      // Baileys is chatty at info level; our own logger reports what matters.
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,      // never appear "online" as a side effect
      syncFullHistory: false,          // we only care about messages from now on
      generateHighQualityLinkPreview: false
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', (u) => this.onConnectionUpdate(u, options));
    this.sock.ev.on('messages.upsert', (u) => this.onMessages(u));

    // History requested via fetchMessageHistory comes back here, not as a normal
    // message event.
    this.sock.ev.on('messaging-history.set', (payload) => this.onHistory(payload));

    // Pairing code must be requested after the socket exists but before scanning.
    if (!hasSession && options.pairingPhone) {
      // Baileys needs a moment before the request will succeed.
      setTimeout(() => this.requestPairingCode(options.pairingPhone), 3000);
    }

    this.state = hasSession ? 'connecting' : 'awaiting_scan';

    if (!hasSession) {
      logger.info('No saved session — link the number to continue');
    } else if (this.reconnectAttempts === 0) {
      logger.info('Restoring saved WhatsApp session');
    }
    // A reconnect is silent here; onConnectionUpdate reports the outcome.
  }

  /**
   * Ask WhatsApp for an 8-digit code to type into the phone. Easier than a QR
   * when the phone and the server are not in the same room.
   * @param {string} phoneNumber - digits with country code, e.g. 919876543210
   */
  async requestPairingCode(phoneNumber) {
    try {
      const digits = String(phoneNumber).replace(/\D/g, '');
      const code = await this.sock.requestPairingCode(digits);
      this.pairingCode = code;
      logger.info(`Pairing code: ${code.match(/.{1,4}/g).join('-')}`);
      logger.info('On the phone: WhatsApp > Linked Devices > Link a Device > Link with phone number');
      this.emit('status', this.status());
    } catch (error) {
      logger.error(`Could not get a pairing code: ${error.message}`);
    }
  }

  /** @private */
  async onConnectionUpdate(update, options) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.state = 'awaiting_scan';
      this.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 }).catch(() => null);
      if (!this.pairingCode) qrcodeTerminal.generate(qr, { small: true });
      this.emit('status', this.status());
    }

    if (connection === 'open') {
      const wasReconnecting = this.reconnectAttempts > 0;
      const gapMs = this.disconnectedAt ? Date.now() - this.disconnectedAt : 0;

      this.state = 'connected';
      this.qrDataUrl = null;
      this.pairingCode = null;
      this.reconnectAttempts = 0;
      this.connectedAt = Date.now();
      this.disconnectedAt = null;
      this.selfPhone = this.sock.user?.id?.split(':')[0] || null;

      this.startWatchdog();

      if (wasReconnecting) {
        // Any reconnect means a window where messages could have been pushed to a
        // dead line. Ask the phone to replay rather than hoping there was nothing.
        this.emit('gap', { seconds: Math.round(gapMs / 1000) });
      }

      if (wasReconnecting) {
        const seconds = Math.round(gapMs / 1000);
        // A long gap is where leads go missing, so say so plainly rather than
        // reporting a reconnect as if nothing happened.
        const report = seconds > 30 ? logger.warn : logger.info;
        report(`WhatsApp reconnected after ${seconds}s offline`);
        if (seconds > 30) {
          logger.warn('Messages sent during that gap may not have been received.');
        }
      } else {
        logger.info(`WhatsApp connected as ${this.selfPhone}`);
      }
      this.emit('status', this.status());
      this.emit('ready');
      return;
    }

    if (connection === 'close') {
      this.stopWatchdog();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      this.state = loggedOut ? 'logged_out' : 'disconnected';
      this.emit('status', this.status());

      if (loggedOut) {
        // The session is dead. We deliberately do NOT delete the folder — that is
        // the user's decision, and deleting it is what forces a physical rescan.
        logger.error('WhatsApp logged out. The number must be linked again.');
        logger.error(`Session folder left intact at ${config.whatsapp.sessionPath}`);
        return;
      }

      if (this.stopping) return;

      if (!this.disconnectedAt) this.disconnectedAt = Date.now();

      // A drop after a long healthy stretch is a new incident, not a continuing
      // failure — restarting the backoff keeps the common case fast.
      if (this.connectedAt && Date.now() - this.connectedAt > STABLE_AFTER_MS) {
        this.reconnectAttempts = 0;
      }

      this.reconnectAttempts += 1;
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
        RECONNECT_MAX_MS
      );
      logger.warn(`Disconnected (${statusCode ?? 'unknown'}) — reconnecting in ${Math.round(delay / 1000)}s`);
      this.emit('disconnected', { statusCode, attempt: this.reconnectAttempts });
      setTimeout(() => this.connect(options).catch((e) => logger.error(e.message)), delay);
    }
  }

  /**
   * Start over with a fresh QR after WhatsApp ended the session.
   *
   * The standing rule is that nothing in this codebase touches the session
   * directory, because deleting it is what forces a physical rescan. This is the
   * one deliberate exception, and it is narrow:
   *
   *   - It refuses unless WhatsApp itself has declared the session dead
   *     (`logged_out`). Credentials that still work are never touched.
   *   - It ARCHIVES rather than deletes, so a session moved aside by mistake can
   *     be moved back by hand.
   *   - It only runs when a signed-in operator asks for it in the panel.
   *
   * Without this the panel was a dead end: it said "restart the bot to link
   * again", which needs the hosting dashboard, so whoever was standing there
   * with the phone could not act on it.
   *
   * @returns {Promise<{ archivedTo: string|null }>}
   */
  async relink() {
    if (this.state !== 'logged_out') {
      throw new Error(
        `Refusing to relink while the session is "${this.state}". `
        + 'This is only for a session WhatsApp has already ended.'
      );
    }

    const sessionPath = config.whatsapp.sessionPath;
    let archivedTo = null;

    if (fs.existsSync(sessionPath)) {
      archivedTo = `${sessionPath}.dead-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(sessionPath, archivedTo);
      logger.warn(`Dead session archived to ${archivedTo}`);
    }

    try {
      await this.sock?.end?.();
    } catch {
      // The socket is already dead — that is the situation we are recovering from.
    }

    this.state = 'disconnected';
    this.reconnectAttempts = 0;
    logger.info('Starting a fresh session — scan the new QR to link a number');

    await this.connect({});
    return { archivedTo };
  }

  /**
   * Ask the phone to replay recent messages for a group.
   *
   * This is the recovery for a gap. WhatsApp will not tell us what we missed, but
   * the primary phone still holds every message, and a linked device can request
   * history from it. Replaying is safe because leads.wa_message_id is UNIQUE — a
   * message already handled is silently ignored.
   *
   * @param {{ waGroupId: string, lastMessageId: string|null,
   *           lastMessageTs: number|null, lastFromMe: boolean }} group
   * @param {number} [count]
   */
  async requestHistory(group, count = 50) {
    if (!this.connected || !group?.lastMessageId) return false;

    try {
      await this.sock.fetchMessageHistory(
        count,
        { remoteJid: group.waGroupId, id: group.lastMessageId, fromMe: Boolean(group.lastFromMe) },
        group.lastMessageTs
      );
      logger.info(`Requested replay of up to ${count} messages for ${group.waGroupId}`);
      return true;
    } catch (error) {
      logger.warn(`Could not request history: ${error.message}`);
      return false;
    }
  }

  /**
   * Handle a replayed batch. Each message goes through the same path as a live
   * one, so nothing is treated specially — deduplication does the rest.
   * @private
   */
  onHistory({ messages }) {
    if (!messages?.length) return;

    let considered = 0;
    for (const raw of messages) {
      const message = normalise(raw);
      if (!message || !message.isGroup) continue;
      if (message.fromMe || this.ownMessageIds.has(message.id)) continue;

      considered += 1;
      this.prepareAndEmit(message, raw).catch((error) =>
        logger.error(`Replayed message ${message.id} failed: ${error.message}`));
    }

    if (considered) logger.info(`Replayed ${considered} message(s) from history`);
  }

  /**
   * Probe the connection periodically and force a reconnect if it has gone quiet.
   * @private
   */
  startWatchdog() {
    if (this.watchdog) return;
    this.probeFailures = 0;

    this.watchdog = setInterval(async () => {
      if (this.state !== 'connected' || !this.sock) return;

      try {
        // A real round trip to WhatsApp. If the socket is a zombie this hangs,
        // which the timeout turns into a failure.
        await Promise.race([
          this.sock.query({
            tag: 'iq',
            attrs: { to: '@s.whatsapp.net', type: 'get', xmlns: 'w:p' },
            content: [{ tag: 'ping', attrs: {} }]
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS))
        ]);
        this.probeFailures = 0;
      } catch (error) {
        this.probeFailures += 1;
        logger.warn(`Connection probe failed (${this.probeFailures}/`
          + `${FAILURES_BEFORE_RECONNECT}): ${error.message}`);

        if (this.probeFailures >= FAILURES_BEFORE_RECONNECT) {
          logger.error('Connection is alive but not responding — forcing a reconnect.');
          logger.error('Messages during this period may have been missed.');
          this.probeFailures = 0;
          this.forceReconnect();
        }
      }
    }, WATCHDOG_INTERVAL_MS);

    this.watchdog.unref?.();
  }

  /** @private */
  stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /**
   * Drop the socket so the normal reconnect path takes over.
   * @private
   */
  forceReconnect() {
    try {
      this.sock?.end(new Error('watchdog: connection unresponsive'));
    } catch {
      // If ending it fails, the close handler still fires.
    }
  }

  /**
   * Translate LID identifiers to phone numbers.
   *
   * WhatsApp now addresses group members by an internal LID ("2807…@lid") rather
   * than by phone number, so a mention often carries no number at all. The group's
   * participant list maps the two, and is cached because it is one round trip per
   * group.
   *
   * @param {string} groupId
   * @param {string[]} lids
   * @returns {Promise<string[]>} E.164 numbers, in the order given
   */
  async resolveLids(groupId, lids) {
    if (!lids?.length) return [];

    let entry = this.lidCache.get(groupId);
    const stale = !entry || Date.now() - entry.at > LID_CACHE_TTL_MS;
    const missing = entry && lids.some((l) => !entry.map.has(l));

    // Refresh when stale, or when someone we have never seen is mentioned —
    // a new joiner must not be silently unresolvable.
    if (stale || missing) {
      try {
        const meta = await this.sock.groupMetadata(groupId);
        const map = new Map();
        for (const participant of meta.participants || []) {
          const lid = participant.lid || participant.id;
          const e164 = phoneFromJid(participant.jid || participant.id);
          if (lid && e164) map.set(lid, e164);
        }
        entry = { map, at: Date.now() };
        this.lidCache.set(groupId, entry);
      } catch (error) {
        logger.warn(`Could not read participants for ${groupId}: ${error.message}`);
        if (!entry) return [];
      }
    }

    return lids.map((lid) => entry.map.get(lid)).filter(Boolean);
  }

  /** @private */
  onMessages({ messages, type }) {
    // 'notify' is a live message. 'append' is history sync, which we ignore —
    // reprocessing old messages would create leads for conversations long since
    // handled.
    if (type !== 'notify') return;

    for (const raw of messages) {
      const message = normalise(raw);
      // Group messages go through the lead pipeline; DMs go through the AI
      // assistant (see index.js). Both are let through here now — only history
      // replay (onHistory, below) stays group-only, since that path exists
      // purely to recover missed leads after a reconnect gap.
      if (!message) continue;

      // S1 — never react to our own output. Its replies contain no mention and no
      // phone number, and without this guard the bot can talk to itself.
      if (message.fromMe || this.ownMessageIds.has(message.id)) {
        this.ownMessageIds.delete(message.id);
        continue;
      }

      // Resolve identities before handing the message on, so the pipeline only
      // ever sees phone numbers.
      this.prepareAndEmit(message, raw).catch((error) =>
        logger.error(`Failed to prepare message ${message.id}: ${error.message}`));
    }
  }

  /**
   * Fill in phone numbers for LID-addressed mentions and senders, then emit.
   * @private
   */
  async prepareAndEmit(message, raw) {
    // A LID is resolved against a group's participant list, so this is only
    // possible in a group. Without the guard a direct chat asked for the
    // participants of group `null` and waited for that to time out — fifteen
    // seconds added to every DM before the customer's message was even looked
    // at, and a reply that arrived long after they had put the phone down.
    if (message.groupId) {
      if (message.pendingLids?.length) {
        const resolved = await this.resolveLids(message.groupId, message.pendingLids);
        message.mentions = [...new Set([...message.mentions, ...resolved])];
      }

      if (!message.senderPhone && message.senderIsLid) {
        const [sender] = await this.resolveLids(message.groupId, [message.senderJid]);
        if (sender) message.senderPhone = sender;
      }
    }

    // raw is passed through so a reply can quote the message that triggered it.
    this.emit('message', message, raw);
  }

  /**
   * Whether another send is allowed inside the rate-limit window (S3).
   * @private
   */
  withinRateLimit() {
    const now = Date.now();
    this.sendTimestamps = this.sendTimestamps.filter((t) => now - t < SEND_WINDOW_MS);
    return this.sendTimestamps.length < SEND_MAX_PER_WINDOW;
  }

  /**
   * Send a quoted reply into a group.
   *
   * Every bot message is a reply to the message that triggered it, so it is always
   * clear which lead is being discussed. Failure to send is logged and swallowed:
   * a send problem must never cost a lead.
   *
   * @param {{ groupId: string, text: string, quoteId?: string,
   *           quoteMessage?: object, mentions?: string[] }} params
   * @returns {Promise<boolean>} whether it was sent
   */
  async reply({ groupId, text, quoteMessage, mentions }) {
    if (!this.connected) {
      logger.warn('Not connected — reply skipped');
      return false;
    }

    if (!this.withinRateLimit()) {
      // Loud, because silently dropping replies would look like the bot ignoring
      // people. Capture is unaffected.
      logger.error(`Send rate limit hit (${SEND_MAX_PER_WINDOW}/min) — reply suppressed`);
      return false;
    }

    try {
      this.sendTimestamps.push(Date.now());
      const sent = await this.sock.sendMessage(
        groupId,
        { text, mentions: toMentionJids(mentions) },
        quoteMessage ? { quoted: quoteMessage } : undefined
      );
      if (sent?.key?.id) this.ownMessageIds.add(sent.key.id);
      return true;
    } catch (error) {
      logger.error(`Failed to send reply: ${error.message}`);
      return false;
    }
  }

  /**
   * Every group this number belongs to.
   * @returns {Promise<{id: string, name: string, participants: number}[]>}
   */
  async listGroups() {
    if (!this.connected) return [];
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all).map((g) => ({
      id: g.id,
      name: g.subject,
      participants: g.participants?.length || 0
    }));
  }

  async disconnect() {
    this.stopping = true;
    this.stopWatchdog();
    if (this.sock) {
      try {
        this.sock.end();
      } catch {
        // Already gone.
      }
    }
    this.state = 'disconnected';
    logger.info('WhatsApp client stopped');
  }
}

module.exports = { WhatsAppClient };
