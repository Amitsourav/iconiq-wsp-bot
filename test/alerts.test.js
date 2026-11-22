const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const { config } = require('../src/config');
const { Alerter, HealthWatch, customersSilent } = require('../src/alerts');

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A HealthWatch on a fake clock, recording every email instead of sending. */
function setup({ state = 'connected', hour = 14, lastCustomerAt = null, keyOk = true } = {}) {
  const sent = [];
  const clock = { now: Date.parse('2026-11-22T08:30:00Z') };
  const whatsapp = { state };
  const alerter = new Alerter({ send: async (email) => { sent.push(email); return true; }, now: () => clock.now });
  const watch = new HealthWatch({
    whatsapp,
    alerter,
    now: () => clock.now,
    hour: () => hour,
    lastCustomerAt: () => (typeof lastCustomerAt === 'function' ? lastCustomerAt(clock.now) : lastCustomerAt),
    checkKey: async () => (keyOk ? { ok: true, detail: 'ok' } : { ok: false, detail: 'OpenRouter 401: User not found.' })
  });
  return { sent, clock, whatsapp, watch, subjects: () => sent.map((e) => e.subject) };
}

describe('alerts', () => {
  beforeEach(() => {
    config.alerts.qrMinutes = 10;
    config.alerts.offlineMinutes = 15;
    config.alerts.silenceHours = 3;
    config.whatsapp.activeFromHour = 8;
    config.whatsapp.activeUntilHour = 22;
  });

  test('19 Nov: logged out is emailed at once, and only once', async () => {
    const t = setup({ state: 'logged_out' });
    await t.watch.check();
    t.clock.now += 5 * MIN;
    await t.watch.check();
    t.clock.now += 5 * MIN;
    await t.watch.check();

    assert.deepStrictEqual(t.subjects(), ['⚠️ WhatsApp bot is LOGGED OUT']);
    assert.match(t.sent[0].text, /Linked devices/);
  });

  test('a problem still open hours later is sent again, so it is not forgotten', async () => {
    const t = setup({ state: 'logged_out' });
    await t.watch.check();
    t.clock.now += 6 * HOUR;
    await t.watch.check();
    assert.deepStrictEqual(t.subjects(),
      ['⚠️ WhatsApp bot is LOGGED OUT', '⚠️ WhatsApp bot is LOGGED OUT (still happening)']);
  });

  test('19-21 Nov: a QR nobody scans is emailed after 10 minutes, and the fix is too', async () => {
    const t = setup({ state: 'awaiting_scan' });
    await t.watch.check();
    t.clock.now += 9 * MIN;
    await t.watch.check();
    assert.deepStrictEqual(t.subjects(), [], 'not before 10 minutes');

    t.clock.now += 2 * MIN;
    await t.watch.check();
    assert.deepStrictEqual(t.subjects(), ['⚠️ WhatsApp bot is waiting for a QR scan']);

    t.whatsapp.state = 'connected';
    await t.watch.check();
    assert.strictEqual(t.subjects()[1], '✅ Fixed: WhatsApp bot is waiting for a QR scan');
  });

  test('a short disconnect is not an alert; fifteen minutes is', async () => {
    const t = setup({ state: 'disconnected' });
    await t.watch.check();
    t.clock.now += 2 * MIN;
    t.whatsapp.state = 'connected';
    await t.watch.check();
    assert.deepStrictEqual(t.subjects(), []);

    t.whatsapp.state = 'connecting';
    await t.watch.check();
    t.clock.now += 16 * MIN;
    await t.watch.check();
    assert.deepStrictEqual(t.subjects(), ['⚠️ WhatsApp bot is offline']);
  });

  test('15-18 Nov: connected but no customer for 3 working hours is emailed', async () => {
    const t = setup({ state: 'connected', hour: 14, lastCustomerAt: (now) => now - 4 * HOUR });
    await t.watch.check();
    assert.deepStrictEqual(t.subjects(), ['⚠️ No customer messages are reaching the bot']);
    assert.match(t.sent[0].text, /4 hour/);
  });

  test('the first customer after a silence clears it', async () => {
    let last = Date.parse('2026-11-22T08:30:00Z') - 4 * HOUR;
    const t = setup({ state: 'connected', hour: 14, lastCustomerAt: () => last });
    await t.watch.check();
    last = t.clock.now;
    await t.watch.check();
    assert.strictEqual(t.subjects()[1], '✅ Fixed: No customer messages are reaching the bot');
  });

  test('a quiet night is not an alert, nor the first hours of the morning', () => {
    const now = Date.parse('2026-11-22T08:30:00Z');
    const lastCustomerAt = now - 12 * HOUR; // last night
    assert.strictEqual(customersSilent({ lastCustomerAt, now, hour: 23 }), false, 'night');
    assert.strictEqual(customersSilent({ lastCustomerAt, now, hour: 3 }), false, 'night');
    assert.strictEqual(customersSilent({ lastCustomerAt, now, hour: 9 }), false, '9 AM');
    assert.strictEqual(customersSilent({ lastCustomerAt, now, hour: 10 }), false, '10 AM');
    assert.strictEqual(customersSilent({ lastCustomerAt, now, hour: 11 }), true, '11 AM, 3h into the day');
    assert.strictEqual(customersSilent({ lastCustomerAt: null, now, hour: 14 }), false, 'never had one');
  });

  test('21 Nov: a dead AI key is emailed, checked again only every few hours', async () => {
    let calls = 0;
    const t = setup({ keyOk: false });
    t.watch.checkKey = async () => { calls += 1; return { ok: false, detail: 'OpenRouter 401: User not found.' }; };
    await t.watch.check();
    t.clock.now += 1 * MIN;
    await t.watch.check();

    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(t.subjects(), ['⚠️ The AI key (OpenRouter) is not working']);
    assert.match(t.sent[0].text, /OPENROUTER_API_KEY/);
  });

  test('nothing wrong, nothing sent', async () => {
    const t = setup({ state: 'connected', lastCustomerAt: (now) => now - 10 * MIN });
    await t.watch.check();
    t.clock.now += 30 * MIN;
    await t.watch.check();
    assert.deepStrictEqual(t.sent, []);
  });
});
