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

describe('a LID mistaken for a phone number never becomes a lead', () => {
  const { ensureCrmLead } = require('../src/pipeline/dmSync');
  const LID_CHAT = '79955161551055@lid';

  function fresh() {
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();
  }

  test('the migration clears a phone that is really the LID', (t) => {
    t.after(() => { db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });
    fresh();

    // Exactly the shape the old bug left behind.
    db.get().prepare(`
      INSERT INTO dm_threads (chat_id, phone, crm_lead_id, captured)
      VALUES (?, '+79955161551055', 'OLD-LEAD', '{"city":"x"}')
    `).run(LID_CHAT);
    // A genuine overseas number on a LID chat must be left alone.
    db.get().prepare(`
      INSERT INTO dm_threads (chat_id, phone) VALUES ('12345@lid', '+96569950748')
    `).run();

    // Re-run the repair the migration performs.
    db.get().prepare(`
      UPDATE dm_threads
      SET phone = NULL, crm_lead_id = NULL, captured = NULL
      WHERE chat_id LIKE '%@lid' AND phone IS NOT NULL
        AND replace(replace(phone, '+', ''), ' ', '')
            = substr(chat_id, 1, instr(chat_id, '@') - 1)
    `).run();

    assert.equal(db.get().prepare('SELECT phone FROM dm_threads WHERE chat_id = ?')
      .get(LID_CHAT).phone, null, 'the invented number should be gone');
    assert.equal(db.get().prepare("SELECT phone FROM dm_threads WHERE chat_id = '12345@lid'")
      .get().phone, '+96569950748', 'a real overseas number must survive');
  });

  test('no lead is created from a LID-derived number', async (t) => {
    t.after(() => { db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });
    fresh();

    const created = [];
    const crm = {
      configured: true,
      async findByPhone() { return { status: 'none', lead: null }; },
      async createLead(f) { created.push(f); return { lead: { id: 'X' }, deferred: {}, dropped: [] }; }
    };

    db.get().prepare(`
      INSERT INTO dm_threads (chat_id, phone) VALUES (?, '+79955161551055')
    `).run(LID_CHAT);

    const result = await ensureCrmLead(crm, repo.dmThreads.byChatId(LID_CHAT));

    assert.equal(result.status, 'no_phone');
    assert.equal(created.length, 0,
      'the retry worker must stop rebuilding this lead every time it is deleted');
  });

  test('a real number on a LID chat still works', async (t) => {
    t.after(() => { db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });
    fresh();

    const created = [];
    const crm = {
      configured: true,
      async findByPhone() { return { status: 'none', lead: null }; },
      async createLead(f) { created.push(f); return { lead: { id: 'Y' }, deferred: {}, dropped: [] }; }
    };

    db.get().prepare(`
      INSERT INTO dm_threads (chat_id, phone) VALUES (?, '+917004428198')
    `).run(LID_CHAT);

    const result = await ensureCrmLead(crm, repo.dmThreads.byChatId(LID_CHAT));

    assert.equal(result.status, 'ok');
    assert.equal(created[0].phone, '+917004428198');
  });
});

describe('the bot does not answer instantly', () => {
  const CHAT_D = '919000000088@s.whatsapp.net';

  test('it waits before the first reply, and between the two', async (t) => {
    // Replying in microseconds is what left the third message showing
    // "Waiting for this message": WhatsApp had not finished settling the
    // session for the message it had just delivered.
    const before = { mode: config.ai.dmMode, delay: config.ai.replyDelayMs, gap: config.ai.replyGapMs };
    config.ai.dmMode = 'script';
    config.ai.replyDelayMs = 120;
    config.ai.replyGapMs = 60;
    t.after(() => {
      config.ai.dmMode = before.mode;
      config.ai.replyDelayMs = before.delay;
      config.ai.replyGapMs = before.gap;
      db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    });

    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();

    const at = [];
    const started = Date.now();
    const o = new Orchestrator({ crm: { configured: false },
      whatsapp: { async reply() { at.push(Date.now() - started); return true; } } });

    await o.handleDirect(normalise({
      key: { id: 'd1', remoteJid: CHAT_D, fromMe: false },
      message: { conversation: 'Hi' }, messageTimestamp: 1
    }));
    await o.settled();

    assert.equal(at.length, 2);
    assert.ok(at[0] >= 120, `first reply came after ${at[0]}ms, expected a pause`);
    assert.ok(at[1] - at[0] >= 60, `no gap between the two (${at[1] - at[0]}ms)`);
  });

  test('a delay of zero sends immediately, for tests and for tuning', async (t) => {
    const before = { mode: config.ai.dmMode, delay: config.ai.replyDelayMs, gap: config.ai.replyGapMs };
    config.ai.dmMode = 'script';
    config.ai.replyDelayMs = 0;
    config.ai.replyGapMs = 0;
    t.after(() => {
      config.ai.dmMode = before.mode;
      config.ai.replyDelayMs = before.delay;
      config.ai.replyGapMs = before.gap;
      db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    });

    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();

    const started = Date.now();
    const o = new Orchestrator({ crm: { configured: false },
      whatsapp: { async reply() { return true; } } });

    await o.handleDirect(normalise({
      key: { id: 'd2', remoteJid: CHAT_D, fromMe: false },
      message: { conversation: 'Hi' }, messageTimestamp: 1
    }));
    await o.settled();

    assert.ok(Date.now() - started < 100, 'zero should mean no wait at all');
  });
});
