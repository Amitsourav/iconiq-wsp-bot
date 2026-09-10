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

describe('a lead deleted in the CRM does not break the chat forever', () => {
  const CHAT = '79955161551055@lid';

  function fresh() {
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();
  }

  test('a 404 makes the bot let go and create a fresh lead', async (t) => {
    t.after(() => { db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });
    fresh();

    const created = [];
    let leadExists = false;
    const crm = {
      configured: true,
      async findByPhone() { return { status: 'none', lead: null }; },
      async createLead(f) { created.push(f); leadExists = true; return { lead: { id: 'NEW' }, deferred: {}, dropped: [] }; },
      async addLeadMessage() {
        if (!leadExists) {
          const e = new Error('POST /leads/OLD/messages → 404: Lead not found');
          e.status = 404;
          throw e;
        }
        return {};
      },
      async updateLead() { return { lead: null, dropped: [] }; }
    };
    const o = new Orchestrator({ crm, whatsapp: { async reply() { return true; } } });

    // A thread left pointing at a lead someone deleted, with fields it thinks
    // are already written.
    repo.dmThreads.upsert(CHAT, '+917004428198');
    repo.dmThreads.setCrmLead(CHAT, 'OLD');
    repo.dmThreads.setCaptured(CHAT, { city: 'Patna' });
    repo.dmMessages.create({ waMessageId: 'k1', chatId: CHAT, direction: 'in', body: 'Hi' });

    await o.syncDmToCrm(CHAT);

    assert.equal(repo.dmThreads.byChatId(CHAT).crm_lead_id, null,
      'the dead id should have been dropped');
    assert.deepEqual(repo.dmThreads.captured(CHAT), {},
      'the fresh lead needs every field written again');

    // The next message rebuilds everything.
    await o.ensureDmLead(CHAT);
    await o.syncDmToCrm(CHAT);

    assert.equal(created.length, 1);
    assert.equal(repo.dmThreads.byChatId(CHAT).crm_lead_id, 'NEW');
  });

  test('an ordinary failure does NOT throw the lead away', async (t) => {
    t.after(() => { db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });
    fresh();

    const crm = {
      configured: true,
      async addLeadMessage() { throw new Error('Network error: fetch failed'); }
    };
    const o = new Orchestrator({ crm, whatsapp: { async reply() { return true; } } });

    repo.dmThreads.upsert(CHAT, '+917004428198');
    repo.dmThreads.setCrmLead(CHAT, 'STILL-THERE');
    repo.dmMessages.create({ waMessageId: 'k2', chatId: CHAT, direction: 'in', body: 'Hi' });

    await o.syncDmToCrm(CHAT);

    assert.equal(repo.dmThreads.byChatId(CHAT).crm_lead_id, 'STILL-THERE',
      'an unreachable CRM must not cause a second lead for the same person');
  });
});

describe('starting a chat over', () => {
  const CHAT = '79955161551055@lid';

  function fresh() {
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();
  }

  test('a chat can be found by the number, not just its id', (t) => {
    t.after(() => { db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });
    fresh();

    repo.dmThreads.upsert(CHAT, '+917004428198');

    // A LID chat id is unrecognisable to a person; the number is what they know.
    assert.equal(repo.dmThreads.find('917004428198')?.chat_id, CHAT);
    assert.equal(repo.dmThreads.find('+91 70044 28198')?.chat_id, CHAT);
    assert.equal(repo.dmThreads.find(CHAT)?.chat_id, CHAT);
    assert.equal(repo.dmThreads.find('919999999999'), null);
    assert.equal(repo.dmThreads.find(''), null);
  });

  test('resetting puts the next message back to the greeting', async (t) => {
    const before = config.ai.dmMode;
    config.ai.dmMode = 'script';
    t.after(() => { config.ai.dmMode = before; db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });
    fresh();

    // A conversation well past the end of the script.
    repo.dmThreads.upsert(CHAT, '+917004428198');
    for (let i = 0; i < 8; i++) {
      repo.dmMessages.create({
        waMessageId: 'old' + i, chatId: CHAT, direction: i % 2 ? 'out' : 'in', body: 'x'
      });
    }

    const sends = [];
    const o = new Orchestrator({ crm: { configured: false },
      whatsapp: { async reply({ text }) { sends.push(text); return true; } } });
    const say = (id) => normalise({
      key: { id, remoteJid: CHAT, fromMe: false },
      message: { conversation: 'Hi' }, messageTimestamp: 1
    });

    await o.handleDirect(say('before-reset'));
    await o.settled();
    assert.equal(sends.length, 0, 'past the script, the bot stays quiet');

    // Eight seeded, plus the one just sent that the bot stayed quiet about.
    const { messages } = repo.dmThreads.reset(CHAT);
    assert.equal(messages, 9);
    assert.equal(repo.dmThreads.byChatId(CHAT), null);

    await o.handleDirect(say('after-reset'));
    await o.settled();

    assert.equal(sends.length, 2, 'after a reset it greets them again');
    assert.match(sends[0], /thanks for reaching out to Iconiq Energy/);
  });
});
