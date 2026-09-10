/**
 * The fixed enquiry script.
 *
 * Three messages and then silence, decided from what the customer has actually
 * sent rather than from memory, so a redeploy mid-enquiry does not greet them
 * a second time.
 */
const { test, describe, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Before anything reads config: these tests must never touch the real database.
const TEST_DB = path.join(__dirname, '..', 'data', 'test-dm-script.db');
process.env.DB_PATH = TEST_DB;

const openrouter = require('../src/ai/openrouter');
const db = require('../src/db');
const repo = require('../src/db/repositories');
const { config } = require('../src/config');
const { normalise } = require('../src/whatsapp/messages');
const { Orchestrator } = require('../src/pipeline/orchestrator');
const assistant = require('../src/ai/assistant');

describe('the fixed enquiry script', () => {
  const CHAT = '919000000077@s.whatsapp.net';

  /** Run a whole conversation and return what the bot said, message by message. */
  async function converse(lines) {
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();

    const sends = [];
    const crm = { configured: false };
    const o = new Orchestrator({ crm, whatsapp: { async reply({ text }) { sends.push(text); return true; } } });

    for (const [i, text] of lines.entries()) {
      await o.handleDirect(normalise({
        key: { id: 'sc' + i, remoteJid: CHAT, fromMe: false },
        message: { conversation: text }, messageTimestamp: 1
      }));
    }
    await o.settled();
    return { sends, crm };
  }

  test('three messages, then silence', async (t) => {
    const before = config.ai.dmMode;
    config.ai.dmMode = 'script';
    t.after(() => { config.ai.dmMode = before; db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });

    const { sends } = await converse([
      'Hi',
      'Amit\namit@x.com\nAcme\nPune',
      'what is the price?',
      'hello?'
    ]);

    assert.equal(sends.length, 3, `expected 3 replies, got ${sends.length}`);
    assert.match(sends[0], /thanks for reaching out to Iconiq Energy/);
    assert.match(sends[1], /1\. Name/);
    assert.equal(sends[2], assistant.DM_CLOSING);
  });

  test('the closing line is exactly what was asked for', () => {
    assert.equal(assistant.DM_CLOSING,
      'Thanks for sharing your details. Our team will get in touch with you.');
  });

  test('no model call is made anywhere in the script', async (t) => {
    const before = config.ai.dmMode;
    config.ai.dmMode = 'script';
    const chat = mock.method(openrouter, 'chat', async () => 'should never run');
    t.after(() => { config.ai.dmMode = before; mock.restoreAll(); db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });

    await converse(['Hi', 'Amit\namit@x.com\nAcme\nPune', 'and again']);

    assert.equal(chat.mock.callCount(), 0, 'the script must cost nothing to run');
  });

  test('a restart mid-enquiry does not start over from the greeting', async (t) => {
    // The step is decided from what the customer has actually sent, read from
    // the database — not from memory, which a redeploy wipes.
    const before = config.ai.dmMode;
    config.ai.dmMode = 'script';
    t.after(() => { config.ai.dmMode = before; db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });

    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();

    // They have already been greeted; the bot then restarted.
    repo.dmThreads.upsert(CHAT, '+919000000077');
    repo.dmMessages.create({ waMessageId: 'r1', chatId: CHAT, direction: 'in', body: 'Hi' });
    repo.dmMessages.create({ waMessageId: 'r2', chatId: CHAT, direction: 'out', body: 'greeting' });

    const sends = [];
    const o = new Orchestrator({ crm: { configured: false },
      whatsapp: { async reply({ text }) { sends.push(text); return true; } } });

    await o.handleDirect(normalise({
      key: { id: 'r3', remoteJid: CHAT, fromMe: false },
      message: { conversation: 'Amit\namit@x.com\nAcme\nPune' }, messageTimestamp: 1
    }));
    await o.settled();

    assert.deepEqual(sends, [assistant.DM_CLOSING],
      'their second message should get the closing line, not the greeting again');
  });
});
