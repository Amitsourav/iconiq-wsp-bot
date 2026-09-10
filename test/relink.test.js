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
