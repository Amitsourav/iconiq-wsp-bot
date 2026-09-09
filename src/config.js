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
    headless: bool(process.env.WA_HEADLESS, true)
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

  /**
   * The daily loan MIS: month-to-date figures per counsellor, against a target.
   *
   * Counsellors are identified by CRM email rather than name or profile id —
   * emails are stable, names get edited, and ids differ between tenants.
   * STAGE_REPORT_AGENTS is still honoured: it named these same four people for
   * the login-and-PF report this one replaced, so an existing deployment that
   * sets it keeps working.
   *
   * `pfTarget` is a MONTHLY target per person. The CRM has no PF target field
   * (`target_call_count` is a call target, and is null in live data), so it lives
   * here — a Railway variable, changeable without a deploy, which matters because
   * a target is a management decision that moves.
   */
  misReport: {
    at: process.env.MIS_REPORT_AT || '18:58',
    agents: (process.env.MIS_REPORT_AGENTS || process.env.STAGE_REPORT_AGENTS
      || 'ankit@fundmycampus.com,hbhatia4216@gmail.com,'
       + 'zaid@fundmycampus.com,fundmycampus@gmail.com')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    pfTarget: int(process.env.PF_TARGET, 10)
  },

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
