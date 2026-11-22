/**
 * Turn libsignal's console output into one summary line per kind per hour.
 *
 * libsignal (under Baileys) writes straight to console.error/warn/info — full
 * session objects and a stack trace for every message it cannot decrypt. After
 * the re-link on 21 Nov 2026 a broken session for our own number produced one
 * of those every few seconds, Railway hit its 500 lines/sec limit and started
 * dropping lines, and the dropped lines included our own warnings. Real errors
 * were being hidden by noise about messages that were never customers'.
 *
 * Only lines that start with libsignal's own fixed wording are caught. Anything
 * else passes through untouched, so this can never hide one of our messages.
 * The first time a kind appears it is logged at once, so a new problem is seen
 * immediately; after that it is counted and summarised.
 */
const logger = require('../logger');

/** libsignal's fixed messages, mapped to the kind they are counted under. */
const PATTERNS = [
  [/^Failed to decrypt message with any known session/, 'decrypt failed'],
  [/^Session error:\s*(?:Session)?Error:\s*(.+?)(?:\s+(?:Session)?Error:|$)/, null], // kind from the error text
  [/^Session error:/, 'session error'],
  [/^Closing session/, 'session closed'],
  [/^Opening session/, 'session opened'],
  [/^Removing old closed session/, 'old session removed'],
  [/^Closing open session in favor of incoming prekey bundle/, 'session replaced'],
  [/^Session already (?:closed|open)/, 'session state'],
  [/^Decrypted message with closed session/, 'decrypted with closed session'],
  [/^Migrating session to/, 'session migrated'],
  [/^Unhandled bucket type/, 'queue bucket']
];

const SUMMARY_EVERY_MS = 60 * 60 * 1000;

/** kind -> count since the last summary */
let counts = new Map();
/** kinds already reported once since start */
const seen = new Set();
let timer = null;
let installed = false;

/**
 * Which libsignal message this is, or null if it is not one.
 * @param {unknown[]} args - the console call's arguments
 * @returns {string|null}
 */
function classify(args) {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (!first) return null;
  for (const [pattern, kind] of PATTERNS) {
    const match = first.match(pattern);
    if (!match) continue;
    if (kind) return kind;
    return match[1] ? `session error: ${match[1].trim().slice(0, 80)}` : 'session error';
  }
  return null;
}

/** Record one libsignal line. Exported for tests. */
function record(kind) {
  if (!seen.has(kind)) {
    seen.add(kind);
    logger.warn(`WhatsApp encryption: ${kind} (further ones are counted and `
      + 'summarised hourly instead of printed)');
    return;
  }
  counts.set(kind, (counts.get(kind) || 0) + 1);
}

/** Log and reset the counts. Exported for tests. */
function flush() {
  if (counts.size === 0) return;
  const parts = [...counts].map(([kind, n]) => `${kind} ×${n}`);
  counts = new Map();
  logger.warn(`WhatsApp encryption, last hour: ${parts.join(', ')}`);
}

/**
 * Patch console.error/warn/info once. Safe to call more than once.
 */
function install() {
  if (installed) return;
  installed = true;

  for (const method of ['error', 'warn', 'info']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const kind = classify(args);
      if (kind) return record(kind);
      return original(...args);
    };
  }

  timer = setInterval(flush, SUMMARY_EVERY_MS);
  timer.unref();
}

module.exports = { install, classify, record, flush };
