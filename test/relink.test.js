/**
 * Relinking after WhatsApp ends a session.
 *
 * The session directory is the one thing in this system that cannot be
 * recreated without physical access to the phone, so the standing rule is that
 * no code touches it. `relink()` is the single deliberate exception, and these
 * tests exist to hold it to the terms of that exception: only a session WhatsApp
 * has already killed, and archived rather than deleted.
 */
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-session-'));
process.env.WA_SESSION_PATH = SESSION;

const { WhatsAppClient } = require('../src/whatsapp/client');

describe('relink', () => {
  let client;

  beforeEach(() => {
    client = new WhatsAppClient();
    // connect() is the only thing relink calls that needs a network; stub it so
    // the guard and the archiving are what is under test.
    client.connect = async () => { client.state = 'awaiting_scan'; };
    fs.mkdirSync(SESSION, { recursive: true });
    fs.writeFileSync(path.join(SESSION, 'creds.json'), '{"me":{"id":"123"}}');
  });

  after(() => {
    fs.rmSync(SESSION, { recursive: true, force: true });
    for (const dir of fs.readdirSync(os.tmpdir())) {
      if (dir.startsWith(path.basename(SESSION) + '.dead-')) {
        fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
      }
    }
  });

  for (const state of ['connected', 'connecting', 'awaiting_scan', 'disconnected']) {
    test(`refuses while the session is "${state}"`, async () => {
      client.state = state;

      await assert.rejects(() => client.relink(), /Refusing to relink/);

      // The credentials must still be exactly where they were.
      assert.ok(fs.existsSync(path.join(SESSION, 'creds.json')),
        'a live session was moved — this is the failure that costs a phone scan');
    });
  }

  test('archives the dead session rather than deleting it', async () => {
    client.state = 'logged_out';

    const { archivedTo } = await client.relink();

    assert.ok(archivedTo, 'nothing was archived');
    assert.ok(fs.existsSync(path.join(archivedTo, 'creds.json')),
      'the old credentials were destroyed instead of set aside');
    assert.equal(fs.existsSync(path.join(SESSION, 'creds.json')), false,
      'the dead session was left in place, so the new QR would never appear');
  });

  test('leaves the client ready to show a fresh QR', async () => {
    client.state = 'logged_out';
    client.reconnectAttempts = 5;

    await client.relink();

    assert.equal(client.state, 'awaiting_scan');
    assert.equal(client.reconnectAttempts, 0, 'backoff carried over from the dead session');
  });

  test('works even if the session folder is already gone', async () => {
    client.state = 'logged_out';
    fs.rmSync(SESSION, { recursive: true, force: true });

    const { archivedTo } = await client.relink();

    assert.equal(archivedTo, null);
    assert.equal(client.state, 'awaiting_scan');
  });
});

describe('send limits protect the number without silencing customers', () => {
  test('one chat is capped, so a reply loop is caught fast', () => {
    const client = new WhatsAppClient();
    const chat = 'a@s.whatsapp.net';

    let allowed = 0;
    while (client.withinRateLimit(chat).ok && allowed < 50) {
      client.sendTimestamps.push({ at: Date.now(), chatId: chat });
      allowed += 1;
    }

    assert.ok(allowed <= 10, `one chat should be capped low, got ${allowed}`);
    assert.equal(client.withinRateLimit(chat).scope, 'this chat');
  });

  test('a busy chat does not silence everyone else', () => {
    // The old global-only cap was 12/min, so six new customers exhausted it and
    // every reply after that was dropped with only a log to say so.
    const client = new WhatsAppClient();
    const busy = 'busy@s.whatsapp.net';

    while (client.withinRateLimit(busy).ok) {
      client.sendTimestamps.push({ at: Date.now(), chatId: busy });
    }

    assert.equal(client.withinRateLimit('someone-else@s.whatsapp.net').ok, true,
      'a different customer must still be answered');
  });

  test('the global cap still exists, for the account', () => {
    const client = new WhatsAppClient();
    let sent = 0;
    while (sent < 100) {
      const chat = `chat-${sent}@s.whatsapp.net`;   // always a fresh chat
      if (!client.withinRateLimit(chat).ok) break;
      client.sendTimestamps.push({ at: Date.now(), chatId: chat });
      sent += 1;
    }

    assert.ok(sent < 100, 'there must still be a ceiling on total sends');
    assert.equal(client.withinRateLimit('another@s.whatsapp.net').scope, 'everything');
  });

  test('old sends fall out of the window', () => {
    const client = new WhatsAppClient();
    const chat = 'a@s.whatsapp.net';
    // Everything sent over a minute ago should no longer count.
    for (let i = 0; i < 40; i++) {
      client.sendTimestamps.push({ at: Date.now() - 61_000, chatId: chat });
    }
    assert.equal(client.withinRateLimit(chat).ok, true);
  });
});
