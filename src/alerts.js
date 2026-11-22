/**
 * Tell a person when the bot stops working.
 *
 * From 15 to 21 Nov 2026 the bot was first deaf (connected, receiving nothing)
 * and then logged out with a QR waiting to be scanned. Both were in the log;
 * nobody reads the log. Six days of customer messages never reached the CRM,
 * and the first anyone knew was the CRM looking empty.
 *
 * Each problem is emailed once when it starts and once when it clears — not
 * every minute while it lasts, which would get the emails filtered and ignored
 * by the second day. A problem still open after REMIND_MS is sent again, so an
 * email that was missed does not mean the problem is forgotten.
 *
 * Everything is also logged at ERROR, so it is visible even with email unset.
 */
const { config } = require('./config');
const logger = require('./logger');
const repo = require('./db/repositories');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const CHECK_EVERY_MS = 60_000;
const REMIND_MS = 6 * 60 * 60 * 1000;
const KEY_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Send one email through Resend.
 * @param {{ subject: string, text: string }} email
 * @returns {Promise<boolean>} whether it was accepted
 */
async function sendEmail({ subject, text }) {
  const { emailTo, resendApiKey, emailFrom } = config.alerts;
  if (!emailTo.length || !resendApiKey) return false;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: emailFrom, to: emailTo, subject, text }),
      signal: AbortSignal.timeout(15_000)
    });
    if (res.ok) return true;
    const body = await res.text().catch(() => '');
    logger.error(`Alert email not sent — Resend ${res.status}: ${body.slice(0, 200)}`);
    return false;
  } catch (error) {
    logger.error(`Alert email not sent: ${error.message}`);
    return false;
  }
}

/**
 * Remembers which problems are open, so each is announced once.
 */
class Alerter {
  /**
   * @param {{ send?: typeof sendEmail, now?: () => number }} [deps]
   */
  constructor({ send = sendEmail, now = Date.now } = {}) {
    this.send = send;
    this.now = now;
    /** key -> { since, lastSentAt, subject } */
    this.open = new Map();
  }

  /**
   * A problem is happening. Emails on the first call, and again every
   * REMIND_MS while it lasts.
   * @param {string} key - stable id, e.g. 'wa-logged-out'
   * @param {string} subject
   * @param {string} text - what happened and what to do about it
   */
  async raise(key, subject, text) {
    const now = this.now();
    const current = this.open.get(key);
    if (current && now - current.lastSentAt < REMIND_MS) return;

    const entry = current || { since: now, subject };
    entry.lastSentAt = now;
    this.open.set(key, entry);

    const again = current ? ' (still happening)' : '';
    logger.error(`ALERT${again}: ${subject} — ${text}`);
    await this.send({ subject: `⚠️ ${subject}${again}`, text: `${text}\n\n— Iconiq WhatsApp bot` });
  }

  /**
   * The problem is over. Emails only if it had been raised.
   * @param {string} key
   * @param {string} text
   */
  async clear(key, text) {
    const current = this.open.get(key);
    if (!current) return;
    this.open.delete(key);

    const minutes = Math.round((this.now() - current.since) / 60_000);
    logger.info(`Alert cleared: ${current.subject} (after ${minutes} min)`);
    await this.send({
      subject: `✅ Fixed: ${current.subject}`,
      text: `${text}\n\nIt lasted about ${minutes} minute(s).\n\n— Iconiq WhatsApp bot`
    });
  }
}

/** The hour of the day in the display timezone, 0-23. */
function hourNow(now) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, hour: '2-digit', hour12: false
  }).format(new Date(now)));
}

/**
 * Whether customers have been silent for longer than normal, counting only
 * working hours.
 *
 * Counting only working hours matters at the start of the day: at 9 AM the
 * last message may be from 9 PM, twelve hours ago, and that is just night.
 * So nothing is said until the working day itself has been running for
 * `silenceHours` with no customer in it.
 *
 * Pure, so it can be tested without a clock.
 *
 * @param {{ lastCustomerAt: number|null, now: number, hour: number }} params
 * @returns {boolean}
 */
function customersSilent({ lastCustomerAt, now, hour }) {
  const { silenceHours } = config.alerts;
  const { activeFromHour, activeUntilHour } = config.whatsapp;
  if (!lastCustomerAt) return false;
  if (hour < activeFromHour || hour >= activeUntilHour) return false;

  const hoursIntoDay = hour - activeFromHour;
  if (hoursIntoDay < silenceHours) return false;

  return now - lastCustomerAt >= silenceHours * 3_600_000;
}

/**
 * Check the OpenRouter key without spending anything.
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function checkOpenRouterKey() {
  const key = config.ai.openrouterApiKey;
  if (!key) return { ok: false, detail: 'OPENROUTER_API_KEY is not set' };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000)
    });
    if (res.ok) return { ok: true, detail: 'ok' };
    const body = await res.text().catch(() => '');
    // Only a rejected key is the key's fault. A 5xx or a timeout is OpenRouter
    // having a bad minute and is not worth waking anyone for.
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `OpenRouter ${res.status}: ${body.slice(0, 150)}` };
    }
    return { ok: true, detail: `OpenRouter ${res.status} (not a key problem)` };
  } catch (error) {
    return { ok: true, detail: `could not reach OpenRouter: ${error.message}` };
  }
}

/**
 * Watches the WhatsApp connection and the AI key, once a minute.
 */
class HealthWatch {
  /**
   * @param {{
   *   whatsapp: { state: string },
   *   alerter?: Alerter,
   *   now?: () => number,
   *   hour?: (now: number) => number,
   *   lastCustomerAt?: () => number|null,
   *   checkKey?: typeof checkOpenRouterKey
   * }} deps
   */
  constructor({
    whatsapp, alerter = new Alerter(), now = Date.now, hour = hourNow,
    lastCustomerAt = () => repo.dmMessages.lastCustomerMessageAt(),
    checkKey = checkOpenRouterKey
  }) {
    this.whatsapp = whatsapp;
    this.alerter = alerter;
    this.now = now;
    this.hour = hour;
    this.lastCustomerAt = lastCustomerAt;
    this.checkKey = checkKey;
    /** state -> when the client entered it */
    this.stateSince = { state: whatsapp.state, at: now() };
    this.lastKeyCheck = 0;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => {
      this.check().catch((error) => logger.error(`Health check failed: ${error.message}`));
    }, CHECK_EVERY_MS);
    this.timer.unref?.();
    // At boot too: a key that died while the bot was down should not wait a minute.
    this.check().catch((error) => logger.error(`Health check failed: ${error.message}`));
  }

  stop() {
    clearInterval(this.timer);
  }

  /** One pass. Exported through the class for tests. */
  async check() {
    const now = this.now();
    const state = this.whatsapp.state;
    if (state !== this.stateSince.state) this.stateSince = { state, at: now };
    const minutesIn = (now - this.stateSince.at) / 60_000;
    const { qrMinutes, offlineMinutes } = config.alerts;
    const panel = 'Open the admin panel and go to the Connection tab.';

    if (state === 'logged_out') {
      await this.alerter.raise('wa-logged-out', 'WhatsApp bot is LOGGED OUT',
        'WhatsApp ended the bot\'s session. Usually someone removed it from Linked devices '
        + 'on the Iconiq phone. No customer messages are reaching the CRM until it is linked '
        + `again. ${panel} Press "Link a number again" and scan the QR with the Iconiq phone.`);
    } else {
      await this.alerter.clear('wa-logged-out', 'The bot is linked again.');
    }

    if (state === 'awaiting_scan' && minutesIn >= qrMinutes) {
      await this.alerter.raise('wa-qr', 'WhatsApp bot is waiting for a QR scan',
        `A QR code has been waiting for ${Math.round(minutesIn)} minutes and nobody has scanned it. `
        + `No customer messages are reaching the CRM. ${panel} On the Iconiq phone: WhatsApp → `
        + 'Settings → Linked devices → Link a device, then scan the QR.');
    } else if (state !== 'awaiting_scan') {
      await this.alerter.clear('wa-qr', 'The QR was scanned and the bot is linked.');
    }

    const offline = state === 'disconnected' || state === 'connecting';
    if (offline && minutesIn >= offlineMinutes) {
      await this.alerter.raise('wa-offline', 'WhatsApp bot is offline',
        `The bot has not been connected to WhatsApp for ${Math.round(minutesIn)} minutes and is `
        + 'still trying. Check that the Iconiq phone has internet. If it does not recover, '
        + 'restart the bot in Railway.');
    } else if (!offline) {
      await this.alerter.clear('wa-offline', 'The bot is connected to WhatsApp again.');
    }

    if (state === 'connected') {
      const lastCustomerAt = this.lastCustomerAt();
      if (customersSilent({ lastCustomerAt, now, hour: this.hour(now) })) {
        const hours = Math.round((now - lastCustomerAt) / 3_600_000);
        await this.alerter.raise('wa-silent', 'No customer messages are reaching the bot',
          `The bot says it is connected, but no customer has messaged for ${hours} hour(s) `
          + 'during working hours — normally 50-90 customers write each day. WhatsApp may have '
          + 'stopped delivering. Check the Iconiq phone: if customers have written, the bot is '
          + `not receiving. ${panel} Press "Log out and link again", then scan the new QR.`);
      } else if (lastCustomerAt && now - lastCustomerAt < 3_600_000) {
        await this.alerter.clear('wa-silent', 'Customer messages are arriving again.');
      }
    }

    if (now - this.lastKeyCheck >= KEY_CHECK_EVERY_MS) {
      this.lastKeyCheck = now;
      const key = await this.checkKey();
      if (!key.ok) {
        await this.alerter.raise('openrouter-key', 'The AI key (OpenRouter) is not working',
          `${key.detail}. Without it the bot cannot read city, company, load, backup, dealer or `
          + 'brand from what customers type, so those CRM fields stay empty. Make a new key at '
          + 'openrouter.ai → Keys and put it in Railway → iconiq-wsp-bot → Variables → '
          + 'OPENROUTER_API_KEY.');
      } else {
        await this.alerter.clear('openrouter-key', 'The AI key works again.');
      }
    }
  }
}

module.exports = { Alerter, HealthWatch, customersSilent, checkOpenRouterKey, sendEmail };
