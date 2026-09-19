/**
 * Central configuration. Everything reads from here — never from process.env directly.
 *
 * Config is validated once at boot so misconfiguration fails loudly and immediately,
 * rather than surfacing hours later as a silent sync failure.
 */
require('dotenv').config();

const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Parse a string env var into a boolean. */
function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Parse a string env var into an integer. */
function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

const config = {
  env: process.env.NODE_ENV || 'development',

  server: {
    port: int(process.env.PORT, 3001),
    // Bind to loopback by default so the panel is not exposed to the internet
    // unless you deliberately put it behind a reverse proxy or open the firewall.
    host: process.env.HOST || '0.0.0.0'
  },

  auth: {
    user: process.env.ADMIN_USER,
    pass: process.env.ADMIN_PASS,
    jwtSecret: process.env.JWT_SECRET,
    tokenTtl: process.env.TOKEN_TTL || '12h'
  },

  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    // The tab name is honoured everywhere — v1 ignored this and hardcoded "Sheet1".
    tabName: process.env.GOOGLE_SHEET_TAB || 'Sheet1',
    credentialsPath: path.resolve(
      ROOT,
      process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json'
    ),
    // Sheet layout: row 2 = section labels, row 3 = headers, data begins row 4.
    sectionRow: int(process.env.SHEET_SECTION_ROW, 2),
    headerRow: int(process.env.SHEET_HEADER_ROW, 3),
    dataStartRow: int(process.env.SHEET_DATA_START_ROW, 4)
  },

  whatsapp: {
    sessionPath: path.resolve(ROOT, process.env.WA_SESSION_PATH || './.wwebjs_auth'),
    // Chrome needs an explicit binary path on some servers.
    chromePath: process.env.CHROME_PATH || undefined,
    headless: bool(process.env.WA_HEADLESS, true),

    /**
     * Which address a direct chat is answered on.
     *
     *   'chat'  the conversation the message arrived on — what WhatsApp itself
     *           does, and what keeps ONE encryption session per person
     *   'pn'    the sender's phone JID
     *
     * Answering a LID-addressed chat on the phone JID opens a second session
     * with the same person, and the recipient's phone then cannot decrypt what
     * we send — that is what "Waiting for this message" is. Kept switchable
     * because it was briefly 'pn', and being able to put it back without a
     * deploy is worth more than the tidiness of removing the option.
     */
    replyTo: process.env.WA_REPLY_TO === 'pn' ? 'pn' : 'chat',

    /**
     * How long the bot may hear nothing before it treats the connection as deaf
     * and forces a reconnect.
     *
     * On 2026-09-19 the socket stopped receiving at 11:37 and nothing noticed
     * for five hours. The liveness watchdog could not: it asks WhatsApp "are you
     * there?", and WhatsApp kept answering yes while delivering nothing. The
     * only symptom of a deaf connection is silence, so silence is what has to be
     * measured.
     *
     * Forty-five minutes is comfortably longer than a normal daytime gap on this
     * number and short enough that a deaf spell costs one quiet hour rather than
     * an afternoon.
     */
    silenceMinutes: int(process.env.WA_SILENCE_MINUTES, 45),

    /**
     * The hours during which silence is suspicious, in the display timezone.
     *
     * Outside them an empty inbox is just night, and reconnecting every 45
     * minutes until morning would be churn with nothing to gain — each
     * reconnect costs a re-handshake and a burst of session renegotiation.
     */
    activeFromHour: int(process.env.WA_ACTIVE_FROM_HOUR, 8),
    activeUntilHour: int(process.env.WA_ACTIVE_UNTIL_HOUR, 22),

    /**
     * How far back a replayed message may reach before we stop acting on it.
     *
     * After a reconnect WhatsApp hands back what it could not deliver, marked as
     * history rather than as live traffic. Those messages used to be discarded
     * wholesale — which is how 23 of them, several from real customers, were
     * binned on 2026-09-19 immediately after the outage that caused them.
     *
     * Replaying is safe by construction: every table keyed on wa_message_id has
     * it UNIQUE, so a message already handled is a no-op. The limit is not about
     * duplicates but about age — answering someone who wrote yesterday is
     * helpful, answering a conversation from last month is not.
     */
    replayMaxAgeHours: int(process.env.WA_REPLAY_MAX_AGE_HOURS, 24),

    /**
     * Ask WhatsApp for the conversation history it holds, on the next connect.
     *
     * Off normally — it is a large download of chats already dealt with. Its
     * purpose is recovery after an outage: messages that were never recorded
     * exist nowhere but on the phone, and this is the only way to ask for them
     * back. Turn it on, restart, let the history arrive, turn it off again.
     *
     * Recovered conversations are captured and filed but never answered; see
     * `message.replayed` in whatsapp/client.js.
     */
    syncFullHistory: bool(process.env.WA_SYNC_FULL_HISTORY, false)
  },

  crm: {
    baseUrl: process.env.CRM_BASE_URL,
    apiKey: process.env.CRM_API_KEY,
    companyId: process.env.CRM_COMPANY_ID,
    // The profile the API key resolves to. Used to recognise our own writes.
    serviceProfileId: process.env.CRM_SERVICE_PROFILE_ID,
    // Startup refuses to write if the key resolves to a different company.
    expectedCompanyId: process.env.CRM_EXPECTED_COMPANY_ID,

    /**
     * Where a lead the bot captures is recorded as having come from.
     *
     * The CRM made lead_source_id mandatory on 2026-09-07 and every create has
     * failed since. It lives here rather than being hardcoded so the id can be
     * repointed from Railway if the source list is ever rebuilt — a deploy to
     * change one UUID is a deploy nobody will make in a hurry.
     *
     * Default is the CRM's own "WhatsApp" source.
     */
    leadSourceId: process.env.CRM_LEAD_SOURCE_ID || '01f49d3f-e1f9-4297-831b-aeabe6524744'
  },

  db: {
    path: path.resolve(ROOT, process.env.DB_PATH || './data/bot.db')
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: path.resolve(ROOT, process.env.LOG_DIR || './logs'),
    // How many log lines to retain in the database for the panel's log view.
    retainInDb: int(process.env.LOG_RETAIN, 2000)
  },

  timezone: process.env.TZ_DISPLAY || 'Asia/Kolkata',

  /**
   * Who may move a lead to someone else.
   *
   * Reassignment takes work off whoever had it, so it is restricted to named
   * numbers rather than anyone in the employee map. Comma-separated E.164;
   * change it in Railway's variables, no code change needed.
   */
  reassignAllowed: (process.env.REASSIGN_ALLOWED || '+917827225354')
    .split(',').map((s) => s.trim()).filter(Boolean),

  /** Duplicate suppression window, in minutes. */
  dedupeWindowMinutes: int(process.env.DEDUPE_WINDOW_MINUTES, 10),

  /**
   * When the day's DM chatbot conversations get pushed into the CRM (see
   * pipeline/dmSync.js). Runs late in the day by default so a chat that's
   * still going gets synced whole rather than in fragments.
   */
  dmSync: {
    at: process.env.DM_CRM_SYNC_AT || '22:30'
  },

  /**
   * AI conversational replies, via OpenRouter.
   *
   * Only covers DMs to the bot's number and non-bank groups. Bank groups are
   * locked out at the database level (group.purpose === 'bank' forces
   * send_enabled to 0) and this stays that way on purpose — see
   * pipeline/bank.js. An automated reply into a bank-run group risks the
   * number being removed from it, which would take the whole lead pipeline
   * down with it.
   */
  ai: {
    enabled: bool(process.env.AI_REPLY_ENABLED, false),
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5',
    // Sent to OpenRouter as attribution headers — optional, cosmetic only.
    siteUrl: process.env.OPENROUTER_SITE_URL || '',
    siteName: process.env.OPENROUTER_SITE_NAME || 'WhatsApp Lead Bot',
    // Whether the assistant answers 1-on-1 chats to the bot's own number.
    replyInDms: bool(process.env.AI_REPLY_IN_DMS, true),
    // Whether it answers ordinary (non-lead) chatter in your own/inhouse groups.
    replyInGroups: bool(process.env.AI_REPLY_IN_GROUPS, true),
    // How many past user+assistant turns to keep per chat, for context.
    historyTurns: int(process.env.AI_HISTORY_TURNS, 6),

    /**
     * How the bot answers a direct message.
     *
     *   'script'  three fixed messages — greeting, the details to send, and a
     *             thank-you once they reply — then silence. No model call, so
     *             every conversation is identical, free, and cannot say
     *             anything nobody approved.
     *   'ai'      a real conversation, answering questions from the product
     *             knowledge base and asking for load, backup and existing
     *             solar or DG.
     *
     * Script while the bot is new: an automated sales conversation is a bigger
     * promise to a customer than an enquiry form, and it should be turned on
     * deliberately rather than by default. The AI path is kept and tested, so
     * it is one variable away.
     */
    dmMode: (process.env.DM_MODE || 'script').toLowerCase() === 'ai' ? 'ai' : 'script',

    /**
     * How long to wait before answering a direct message, in milliseconds.
     *
     * Replying the instant a message is decrypted is too fast for WhatsApp.
     * Seen live: with the model writing the replies there was a natural five to
     * ten second pause and every message arrived; with the fixed script, which
     * answers in microseconds, the third message consistently landed as
     * "Waiting for this message" — the recipient's phone had not finished
     * settling the session for the message it had just sent.
     *
     * It also reads better. A company that answers in nought seconds is
     * obviously a machine; a few seconds looks like someone picking up.
     */
    replyDelayMs: int(process.env.REPLY_DELAY_MS, 4000),

    /**
     * The gap between two messages sent one after the other, in milliseconds.
     *
     * Shorter than the first delay — they are one thought in two bubbles, so a
     * long pause between them reads as hesitation — but not zero, for the same
     * reason as above.
     */
    replyGapMs: int(process.env.REPLY_GAP_MS, 1500),

    /**
     * Whether a DM conversation is read for lead details (name, city, load,
     * backup, existing solar/DG) and written into the CRM's fields.
     *
     * Costs one extra model call per inbound message. Turning it off leaves the
     * bot replying and the transcript still reaching the CRM as a remark — only
     * the structured fields stop being filled, so nothing is lost, it just has
     * to be read rather than reported on.
     */
    extractFields: bool(process.env.AI_EXTRACT_FIELDS, true),
    systemPrompt: process.env.AI_SYSTEM_PROMPT || null
  }
};

/**
 * Validate configuration. Returns a list of fatal problems and a list of warnings.
 * @returns {{ fatal: string[], warnings: string[] }}
 */
function validate() {
  const fatal = [];
  const warnings = [];

  if (!config.auth.user || !config.auth.pass) {
    fatal.push('ADMIN_USER and ADMIN_PASS must be set — the admin panel has no other login.');
  }

  if (!config.auth.jwtSecret) {
    fatal.push('JWT_SECRET must be set. Generate one with: openssl rand -hex 32');
  } else if (config.auth.jwtSecret.length < 32) {
    warnings.push('JWT_SECRET is short. Use at least 32 characters: openssl rand -hex 32');
  }

  // v1 shipped with the literal password "changeme123" still in place.
  const weakPasswords = ['changeme123', 'admin', 'password', '123456', 'changeme'];
  if (config.auth.pass && weakPasswords.includes(config.auth.pass.toLowerCase())) {
    fatal.push(
      `ADMIN_PASS is set to a default value ("${config.auth.pass}"). ` +
      'Anyone who finds this server can log in. Change it before starting.'
    );
  }

  if (!config.crm.baseUrl || !config.crm.apiKey) {
    warnings.push('CRM_BASE_URL / CRM_API_KEY are not set — leads will be captured but not sent.');
  }

  if (config.ai.enabled && !config.ai.openrouterApiKey) {
    fatal.push('AI_REPLY_ENABLED is true but OPENROUTER_API_KEY is not set.');
  }

  return { fatal, warnings };
}

module.exports = { config, validate };
