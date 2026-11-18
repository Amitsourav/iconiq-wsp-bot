/**
 * The 1/2 menu as a WhatsApp poll.
 *
 * Votes are encrypted here exactly as a phone encrypts them, so the decryption
 * the bot relies on is exercised for real rather than mocked.
 */
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-dm-poll.db');
process.env.DB_PATH = TEST_DB;

const { proto } = require('@whiskeysockets/baileys');
const db = require('../src/db');
const repo = require('../src/db/repositories');
const { config } = require('../src/config');
const { normalise } = require('../src/whatsapp/messages');
const { WhatsAppClient } = require('../src/whatsapp/client');
const { Orchestrator } = require('../src/pipeline/orchestrator');
const assistant = require('../src/ai/assistant');

const ME = { id: '919821152633:12@s.whatsapp.net', lid: '111222333444:12@lid' };
const CHAT = '919000000055@s.whatsapp.net';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Encrypt a vote the way a phone does — the inverse of Baileys' decryptPollVote. */
function encryptVote({ option, pollId, secret, creatorJid, voterJid }) {
  const sign = Buffer.concat([
    Buffer.from(pollId), Buffer.from(creatorJid), Buffer.from(voterJid),
    Buffer.from('Poll Vote'), Buffer.from([1])
  ]);
  const key = hmac(hmac(Buffer.alloc(32), secret), sign);
  const iv = crypto.randomBytes(12);
  const plain = proto.Message.PollVoteMessage.encode({
    selectedOptions: option ? [crypto.createHash('sha256').update(option).digest()] : []
  }).finish();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${pollId}\u0000${voterJid}`));
  const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { encPayload: enc, encIv: iv };
}

/** A fake WhatsApp that records what is sent and can really read votes. */
function fakeWhatsApp({ pollFails = false } = {}) {
  const sends = [];
  const polls = [];
  const wa = {
    sock: { user: ME },
    async reply({ text }) { sends.push(text); return true; },
    async sendPoll({ name, options }) {
      if (pollFails) return null;
      const id = 'POLL' + (polls.length + 1);
      const secret = crypto.randomBytes(32);
      polls.push({ id, secret, name, options });
      sends.push(`[poll] ${name}`);
      return { id, secret };
    },
    readPollVote: WhatsAppClient.prototype.readPollVote
  };
  return { wa, sends, polls };
}

let n = 0;
const typed = (text) => normalise({
  key: { id: 'm' + (++n), remoteJid: CHAT, fromMe: false },
  message: { conversation: text }, messageTimestamp: 1
});

function voted(poll, option, { creatorJid = '919821152633@s.whatsapp.net', voterJid = CHAT,
  remoteJid = CHAT, senderPn } = {}) {
  return normalise({
    key: { id: 'v' + (++n), remoteJid, fromMe: false, senderPn },
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: { id: poll.id, remoteJid, fromMe: true },
        vote: encryptVote({ option, pollId: poll.id, secret: poll.secret, creatorJid, voterJid })
      }
    },
    messageTimestamp: 1
  });
}

describe('the menu as a poll', () => {
  const before = { mode: config.ai.dmMode, menu: config.ai.dmMenu,
    delay: config.ai.replyDelayMs, gap: config.ai.replyGapMs };

  beforeEach(() => {
    config.ai.dmMode = 'script';
    config.ai.dmMenu = 'poll';
    config.ai.replyDelayMs = 0;
    config.ai.replyGapMs = 0;
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();
  });

  after(() => {
    Object.assign(config.ai, { dmMode: before.mode, dmMenu: before.menu,
      replyDelayMs: before.delay, replyGapMs: before.gap });
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
  });

  test('greeting, poll, tap 2, details, closing', async () => {
    const { wa, sends, polls } = fakeWhatsApp();
    const o = new Orchestrator({ crm: { configured: false }, whatsapp: wa });

    await o.handleDirect(typed('Hi'));
    await o.settled();
    assert.deepEqual(sends, [assistant.DM_INTRO, '[poll] Please select one of the following']);
    assert.deepEqual(polls[0].options, assistant.DM_MENU_OPTIONS);

    await o.handleDirect(voted(polls[0], assistant.DM_MENU_OPTIONS[1]));
    await o.settled();
    assert.equal(sends[2], assistant.DM_DETAILS[2]);

    await o.handleDirect(typed('Amit\nPune\nAcme\nNo\n-'));
    await o.handleDirect(typed('thanks'));
    await o.settled();
    assert.deepEqual(sends.slice(3), [assistant.DM_CLOSING]);

    // The panel and CRM see the menu and the choice as readable lines.
    const bodies = repo.dmMessages.recentForChat(CHAT).map((r) => `${r.direction}: ${r.body}`);
    assert.ok(bodies.includes(`out: ${assistant.DM_MENU_TEXT}`));
    assert.ok(bodies.includes(`in: 2. ${assistant.DM_MENU_OPTIONS[1]}`));
  });

  test('typing 1 still works with a poll on screen', async () => {
    const { wa, sends } = fakeWhatsApp();
    const o = new Orchestrator({ crm: { configured: false }, whatsapp: wa });

    await o.handleDirect(typed('Hi'));
    await o.handleDirect(typed('1'));
    await o.settled();
    assert.equal(sends[2], assistant.DM_DETAILS[1]);
  });

  test('a poll survives a restart — its key is kept in the database', async () => {
    const first = fakeWhatsApp();
    await new Orchestrator({ crm: { configured: false }, whatsapp: first.wa })
      .handleDirect(typed('Hi'));

    const second = fakeWhatsApp();
    const o = new Orchestrator({ crm: { configured: false }, whatsapp: second.wa });
    await o.handleDirect(voted(first.polls[0], assistant.DM_MENU_OPTIONS[0]));
    await o.settled();
    assert.deepEqual(second.sends, [assistant.DM_DETAILS[1]]);
  });

  test('changing the vote after the details were asked gets no reply', async () => {
    const { wa, sends, polls } = fakeWhatsApp();
    const o = new Orchestrator({ crm: { configured: false }, whatsapp: wa });

    await o.handleDirect(typed('Hi'));
    await o.handleDirect(voted(polls[0], assistant.DM_MENU_OPTIONS[0]));
    await o.handleDirect(voted(polls[0], assistant.DM_MENU_OPTIONS[1]));
    await o.settled();
    assert.deepEqual(sends.slice(2), [assistant.DM_DETAILS[1]],
      'a second tap is not their details, so no closing line');
  });

  test('a vote taken back, or on a poll we never sent, is ignored', async () => {
    const { wa, sends, polls } = fakeWhatsApp();
    const o = new Orchestrator({ crm: { configured: false }, whatsapp: wa });

    await o.handleDirect(typed('Hi'));
    await o.handleDirect(voted(polls[0], null));
    await o.handleDirect(voted({ id: 'NOT-OURS', secret: crypto.randomBytes(32) },
      assistant.DM_MENU_OPTIONS[0]));
    await o.settled();
    assert.equal(sends.length, 2, 'neither should produce a reply, not even the reminder');
  });

  test('a LID-addressed chat votes with LIDs, and is still read', () => {
    const { wa } = fakeWhatsApp();
    const poll = { id: 'P1', secret: crypto.randomBytes(32), options: assistant.DM_MENU_OPTIONS };
    const msg = voted(poll, assistant.DM_MENU_OPTIONS[1], {
      remoteJid: '79955161551055@lid', voterJid: '79955161551055@lid',
      creatorJid: '111222333444@lid', senderPn: '919000000055@s.whatsapp.net'
    });

    assert.equal(wa.readPollVote(msg, poll), 2);
  });

  test('if the poll will not send, the menu goes as text instead', async () => {
    const { wa, sends } = fakeWhatsApp({ pollFails: true });
    const o = new Orchestrator({ crm: { configured: false }, whatsapp: wa });

    await o.handleDirect(typed('Hi'));
    await o.settled();
    assert.deepEqual(sends, [assistant.DM_INTRO, assistant.DM_MENU_TEXT]);

    await o.handleDirect(typed('2'));
    await o.settled();
    assert.equal(sends[2], assistant.DM_DETAILS[2]);
  });
});
