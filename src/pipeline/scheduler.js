/**
 * Daily scheduler.
 *
 * The retry worker is an interval loop; this is a clock. It checks often and
 * fires once per calendar day, recording the day it last ran so a restart — or
 * a redeploy, which happens on every push — cannot post the same summary twice.
 */
const repo = require('../db/repositories');
const logger = require('../logger');
const { config } = require('../config');

/** Checked this often; the job itself still runs only once a day. */
const TICK_MS = 60_000;

class DailyScheduler {
  /**
   * @param {{ name: string, at: string, run: () => Promise<void> }} job
   *   `at` is HH:MM in the display timezone.
   */
  constructor({ name, at, run }) {
    this.name = name;
    this.at = at;
    this.run = run;
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    logger.info(`Scheduled "${this.name}" daily at ${this.at} ${config.timezone}`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Current date and time in the display timezone. */
  now() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());

    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      time: `${get('hour')}:${get('minute')}`
    };
  }

  /** @private */
  async tick() {
    if (this.busy) return;

    const { date, time } = this.now();
    const key = `scheduler:${this.name}:lastRun`;

    if (repo.settings.get(key) === date) return;
    if (time < this.at) return;

    // Recorded before running, not after: if the job throws we would otherwise
    // retry every minute for the rest of the day.
    repo.settings.set(key, date);
    this.busy = true;

    try {
      logger.info(`Running scheduled job "${this.name}"`);
      await this.run();
    } catch (error) {
      logger.error(`Scheduled job "${this.name}" failed: ${error.message}`);
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { DailyScheduler };
