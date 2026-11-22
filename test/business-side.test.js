/**
 * Messages sent from the Iconiq number by someone other than the bot — Meta's
 * Business AI, or the team on the phone — are recorded as our side of the
 * conversation, and never answered.
 */
const { test, describe, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-business-side.db');
process.env.DB_PATH = TEST_DB;

const openrouter = require('../src/ai/openrouter');
const db = require('../src/db');
const repo = require('../src/db/repositories');
const logger = require('../src/logger');
const { config } = require('../src/config');
const { normalise, textOf, describe: describeMessage } = require('../src/whatsapp/messages');
const { Orchestrator } = require('../src/pipeline/orchestrator');
const { WhatsAppClient } = require('../src/whatsapp/client');

const CHAT = '10000000000077@lid'; // made up

function fresh(t) {
  db.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
  db.init();
  const before = { mode: config.ai.dmMode, delay: config.ai.replyDelayMs, gap: config.ai.replyGapMs };
  Object.assign(config.ai, { dmMode: 'script', replyDelayMs: 0, replyGapMs: 0 });
  mock.method(openrouter, 'chat', async () => null);
  t.after(() => {
    Object.assign(config.ai, { dmMode: before.mode, replyDelayMs: before.delay, replyGapMs: before.gap });
    repo.settings.set('sending_paused', 'false');
    mock.restoreAll(); db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
  });
  const sends = [];
  const o = new Orchestrator({ crm: { configured: false },
    whatsapp: { async reply({ text }) { sends.push(text); return true; } } });
  return { o, sends };
}

const raw = (id, fromMe, message) => ({ key: { id, remoteJid: CHAT, fromMe }, message, messageTimestamp: 1 });

describe('the business side of a direct chat', () => {
  test('Meta AI and the customer, in order, with the bot paused and silent', async (t) => {
    const { o, sends } = fresh(t);
    repo.settings.set('sending_paused', 'true');

    const conversation = [
      [false, 'Hi, I need an inverter'],
      [true, 'Happy to help! Which city is the site in?'],
      [false, 'Pune'],
      [true, 'And is this for your own use, or are you a dealer?'],
      [false, 'own use, for my home']
    ];
    for (const [i, [fromMe, text]] of conversation.entries()) {
      const r = raw(`m${i}`, fromMe, { conversation: text });
      if (fromMe) await o.handleOwnDirect(normalise(r), r);
      else await o.handleDirect(normalise(r), r);
    }
    await o.settled();

    const stored = repo.dmMessages.recentForChat(CHAT, 50).map((m) => [m.direction, m.body]);
    assert.deepStrictEqual(stored, conversation.map(([fromMe, text]) => [fromMe ? 'out' : 'in', text]));
    assert.deepStrictEqual(sends, [], 'the bot sent nothing');
  });

  test('a business-side message is never answered, even with sending on', async (t) => {
    const { o, sends } = fresh(t);
    const r = raw('o1', true, { conversation: 'Hello sir, sharing the brochure' });
    await o.handleOwnDirect(normalise(r), r);
    await o.settled();
    assert.deepStrictEqual(sends, []);
    assert.strictEqual(repo.dmMessages.recentForChat(CHAT, 5).length, 1);
  });

  test('a redelivered business-side message is stored once', async (t) => {
    const { o } = fresh(t);
    const r = raw('o2', true, { conversation: 'Which city?' });
    await o.handleOwnDirect(normalise(r), r);
    await o.handleOwnDirect(normalise(r), r);
    await o.settled();
    assert.strictEqual(repo.dmMessages.recentForChat(CHAT, 5).length, 1);
  });

  test('an unreadable message is logged with its type, never silently dropped', async (t) => {
    const { o } = fresh(t);
    const lines = [];
    const off = logger.subscribe((e) => lines.push(e.message));
    t.after(off);

    // What a message that failed to decrypt looks like: a stub, no content.
    const r = { key: { id: 'u1', remoteJid: CHAT, fromMe: false }, messageStubType: 2, messageTimestamp: 1 };
    await o.handleDirect(normalise(r), r);
    await o.settled();

    assert.ok(lines.some((l) => /Could not read a customer message in .*no content stub=2/.test(l)), lines.join('\n'));
  });
});

describe('reading button, list and menu messages', () => {
  test('the types Meta AI and quick replies use come out as text', () => {
    assert.strictEqual(textOf({ interactiveMessage: { body: { text: 'Choose one' } } }), 'Choose one');
    assert.strictEqual(textOf({ interactiveMessage: { header: { title: 'Iconiq' }, body: { text: 'Choose one' } } }),
      'Iconiq\nChoose one');
    assert.strictEqual(textOf({ buttonsMessage: { contentText: 'Pick a size' } }), 'Pick a size');
    assert.strictEqual(textOf({ listMessage: { description: 'Our products' } }), 'Our products');
    assert.strictEqual(textOf({ buttonsResponseMessage: { selectedDisplayText: 'Dealer' } }), 'Dealer');
    assert.strictEqual(textOf({ listResponseMessage: { title: '5 kW' } }), '5 kW');
    assert.strictEqual(textOf({ templateButtonReplyMessage: { selectedDisplayText: 'Yes' } }), 'Yes');
  });

  test('wrapped messages are unwrapped, however deep', () => {
    assert.strictEqual(textOf({ ephemeralMessage: { message: { extendedTextMessage: { text: 'hi' } } } }), 'hi');
    assert.strictEqual(textOf({ deviceSentMessage: { message: { conversation: 'from the phone' } } }), 'from the phone');
    assert.strictEqual(textOf({ botInvokeMessage: { message: { ephemeralMessage: { message: { conversation: 'deep' } } } } }), 'deep');
    assert.strictEqual(textOf({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'datasheet' } } } }), 'datasheet');
  });

  test('describe names the type, never the content', () => {
    const d = describeMessage({ message: { stickerMessage: { url: 'secret' } } });
    assert.strictEqual(d, 'stickerMessage');
  });
});

describe('the number talking to itself', () => {
  test('its own LID and phone chats are recognised, customers are not', () => {
    const c = new WhatsAppClient();
    c.sock = { user: { id: '919800000001:12@s.whatsapp.net', lid: '10000000000001:12@lid' } };
    assert.strictEqual(c.isSelfChat('10000000000001@lid'), true);
    assert.strictEqual(c.isSelfChat('919800000001@s.whatsapp.net'), true);
    assert.strictEqual(c.isSelfChat('10000000000077@lid'), false);
  });
});
