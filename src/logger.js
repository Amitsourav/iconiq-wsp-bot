/**
 * Minimal structured logger: console + daily file + in-process subscribers.
 *
 * v1 used Winston and hooked its internal 'data' event to stream logs to the panel,
 * which was fragile and made timestamps unreliable. Subscribers here are explicit.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

const threshold = LEVELS[config.logging.level] ?? LEVELS.info;

/** @type {Set<(entry: {level: string, message: string, timestamp: string}) => void>} */
const subscribers = new Set();

let stream = null;
let streamDate = null;

/** Get today's date as YYYY-MM-DD in the display timezone. */
function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

/** Lazily open (and daily-rotate) the log file stream. */
function fileStream() {
  const date = today();
  if (stream && streamDate === date) return stream;

  if (stream) stream.end();
  fs.mkdirSync(config.logging.dir, { recursive: true });
  stream = fs.createWriteStream(path.join(config.logging.dir, `bot-${date}.log`), { flags: 'a' });
  streamDate = date;
  return stream;
}

function write(level, message) {
  if (LEVELS[level] > threshold) return;

  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${level.toUpperCase()}] ${message}`;

  console.log(`${COLORS[level] || ''}${line}${RESET}`);

  try {
    fileStream().write(line + '\n');
  } catch {
    // Never let a logging failure take the process down.
  }

  const entry = { level, message, timestamp };
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // A broken subscriber must not break logging for everyone else.
    }
  }
}

const logger = {
  error: (msg) => write('error', msg),
  warn: (msg) => write('warn', msg),
  info: (msg) => write('info', msg),
  debug: (msg) => write('debug', msg),

  /**
   * Subscribe to every log entry (used by the panel's live log stream).
   * @param {(entry: {level: string, message: string, timestamp: string}) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }
};

module.exports = logger;
