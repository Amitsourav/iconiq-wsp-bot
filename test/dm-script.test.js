/**
 * The fixed enquiry script.
 *
 * A greeting with a 1/2 menu, the details for the option chosen, a closing
 * line, then silence — decided from what the bot has already sent, read from
 * the database, so a redeploy mid-enquiry does not greet them a second time.
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

// The menu as text, so these tests read as plain sends. The poll form is
// covered in dm-poll.test.js.
config.ai.dmMenu = 'text';

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

  const DETAILS = 'Amit\nPune\n5 kW\n4 hours';

  function useScript(t) {
    const before = { mode: config.ai.dmMode, delay: config.ai.replyDelayMs, gap: config.ai.replyGapMs };
    config.ai.dmMode = 'script';
    // The real pause is seconds per reply; these tests are about what is said.
    config.ai.replyDelayMs = 0;
    config.ai.replyGapMs = 0;
    t.after(() => {
      config.ai.dmMode = before.mode;
      config.ai.replyDelayMs = before.delay;
      config.ai.replyGapMs = before.gap;
      mock.restoreAll(); db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true }); });
  }

  test('option 1: menu, partner details, closing, then silence', async (t) => {
    useScript(t);
    const { sends } = await converse(['Hi', '1', DETAILS, 'what is the price?', 'hello?']);

    assert.deepEqual(sends, [
      assistant.DM_GREETING,
      assistant.DM_DETAILS[1],
      assistant.DM_CLOSING
    ]);
  });

  test('option 2: menu, order details, closing, then silence', async (t) => {
    useScript(t);
    const { sends } = await converse(['Hello', '2', 'Amit\nPune\nAcme\nYes\nLuminous', 'ok']);

    assert.deepEqual(sends, [
      assistant.DM_GREETING,
      assistant.DM_DETAILS[2],
      assistant.DM_CLOSING
    ]);
  });

  test('the messages are worded exactly as the team wrote them', () => {
    assert.match(assistant.DM_GREETING, /^Hi, thanks for reaching out to Iconiq Energy\./);
    assert.match(assistant.DM_GREETING,
      /1\. I want to become a Channel Partner \(Dealer \/ Distributor\) of Hybrid Solutions\n2\. I want to place an Order for Personal \/ Commercial Use$/);
    assert.match(assistant.DM_DETAILS[1], /3\. Load Capacity \(in kW\) \n4\. Backup required \(in Hrs\)$/);
    assert.match(assistant.DM_DETAILS[2], /3\. Company Name\n4\. Are you currently a Dealer \/ Distributor of another Brand\?\n5\. Please share the Brand name$/);
    assert.equal(assistant.DM_CLOSING,
      'Thanks for sharing your details. Our team will get in touch with you.');
  });

  test('a reply that is not 1 or 2 is asked once more, then left alone', async (t) => {
    useScript(t);
    const { sends } = await converse(['Hi', 'I want inverter', 'price?', '2', 'Amit\nPune\nAcme\nNo\n-']);

    assert.deepEqual(sends, [
      assistant.DM_GREETING,
      assistant.DM_MENU_REMINDER,
      // 'price?' — the reminder has been said once already, so nothing.
      assistant.DM_DETAILS[2],
      assistant.DM_CLOSING
    ]);
  });

  test('only a whole-message choice counts', async (t) => {
    useScript(t);
    for (const reply of ['1', ' 1 ', '1.', '1)', '*1*', 'Option 1', '1️⃣']) {
      const { sends } = await converse(['Hi', reply]);
      assert.equal(sends[1], assistant.DM_DETAILS[1], `"${reply}" should choose option 1`);
    }
    for (const reply of ['I have 1 question', '12', '3', 'one']) {
      const { sends } = await converse(['Hi', reply]);
      assert.equal(sends[1], assistant.DM_MENU_REMINDER, `"${reply}" is not a choice`);
    }
  });

  test('no model call is made anywhere in the script', async (t) => {
    useScript(t);
    const chat = mock.method(openrouter, 'chat', async () => 'should never run');

    await converse(['Hi', 'x', '1', DETAILS, 'and again']);

    assert.equal(chat.mock.callCount(), 0, 'the script must cost nothing to run');
  });

  /** Seed a conversation as if the bot had restarted part-way through it. */
  async function resumeAfter(rows, text) {
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();

    repo.dmThreads.upsert(CHAT, '+919000000077');
    for (const [i, [direction, body]] of rows.entries()) {
      repo.dmMessages.create({ waMessageId: 'seed' + i, chatId: CHAT, direction, body });
    }

    const sends = [];
    const o = new Orchestrator({ crm: { configured: false },
      whatsapp: { async reply({ text: sent }) { sends.push(sent); return true; } } });
    await o.handleDirect(normalise({
      key: { id: 'resume', remoteJid: CHAT, fromMe: false },
      message: { conversation: text }, messageTimestamp: 1
    }));
    await o.settled();
    return sends;
  }

  test('a restart mid-enquiry carries on where it was', async (t) => {
    // The step is decided from what the bot has already sent, read from the
    // database — not from memory, which a redeploy wipes.
    useScript(t);

    assert.deepEqual(await resumeAfter([['in', 'Hi'], ['out', assistant.DM_GREETING]], '2'),
      [assistant.DM_DETAILS[2]], 'a choice after a restart gets its details, not the greeting');

    assert.deepEqual(await resumeAfter([
      ['in', 'Hi'], ['out', assistant.DM_GREETING], ['in', '1'], ['out', assistant.DM_DETAILS[1]]
    ], DETAILS), [assistant.DM_CLOSING]);
  });

  test('someone asked for details by the old script still gets the closing line', async (t) => {
    // Greeted before the menu went live, answering after it.
    useScript(t);
    const sends = await resumeAfter([
      ['in', 'Hi'], ['out', 'old greeting'], ['out', assistant.PREVIOUS_DM_DETAILS_REQUEST]
    ], 'Amit\namit@x.com\nAcme\nPune');

    assert.deepEqual(sends, [assistant.DM_CLOSING]);
  });

  test('messages recovered after an outage do not use up the script', async (t) => {
    // 18 Nov 2026: two messages recovered on re-link were filed without a reply,
    // and the customer's next message was counted as their third — silence.
    useScript(t);

    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();

    const sends = [];
    const o = new Orchestrator({ crm: { configured: false },
      whatsapp: { async reply({ text }) { sends.push(text); return true; } } });
    const say = (id, text, replayed) => {
      const m = normalise({
        key: { id, remoteJid: CHAT, fromMe: false },
        message: { conversation: text }, messageTimestamp: 1
      });
      if (replayed) m.replayed = true;
      return m;
    };

    await o.handleDirect(say('rec1', 'Hi', true));
    await o.handleDirect(say('rec2', 'Hi', true));
    await o.settled();
    assert.equal(sends.length, 0, 'recovered messages are filed, not answered');

    await o.handleDirect(say('live1', 'hi'));
    await o.settled();
    assert.deepEqual(sends, [assistant.DM_GREETING], 'the first live message gets the menu');

    await o.handleDirect(say('live2', '1'));
    await o.handleDirect(say('live3', DETAILS));
    await o.settled();
    assert.deepEqual(sends.slice(1), [assistant.DM_DETAILS[1], assistant.DM_CLOSING]);
  });

  /** A CRM that records what the bot writes, for the enquiry-type tests. */
  function recordingCrm() {
    const writes = { updates: [], remarks: [] };
    return {
      writes,
      crm: {
        configured: true,
        async findByPhone() { return { status: 'none', lead: null }; },
        async createLead() { return { lead: { id: 'LEAD' }, deferred: {}, dropped: [] }; },
        async addLeadMessage() { return {}; },
        async updateLead(leadId, fields) { writes.updates.push([leadId, fields]); return { lead: {}, dropped: [] }; },
        async addRemark(leadId, text) { writes.remarks.push([leadId, text]); return {}; }
      }
    };
  }

  test('the chosen option is saved to the CRM as a field and a remark, once', async (t) => {
    useScript(t);
    const before = config.ai.extractFields;
    config.ai.extractFields = false;
    t.after(() => { config.ai.extractFields = before; });

    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();

    const { crm, writes } = recordingCrm();
    const o = new Orchestrator({ crm, whatsapp: { async reply() { return true; } } });

    for (const [i, text] of ['Hi', '2', 'Amit\nPune\nAcme\nYes\nLuminous', 'thanks'].entries()) {
      await o.handleDirect(normalise({
        key: { id: 'rm' + i, remoteJid: CHAT, fromMe: false },
        message: { conversation: text }, messageTimestamp: 1
      }));
    }
    await o.settled();

    assert.deepEqual(writes.updates, [['LEAD', { enquiry_type: 'personal_order' }]]);
    assert.deepEqual(writes.remarks,
      [['LEAD', 'Enquiry type: Order for Personal / Commercial Use']]);
  });

  test('a failed field write is retried without repeating the remark', async (t) => {
    useScript(t);
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();

    const { crm, writes } = recordingCrm();
    let fail = true;
    const update = crm.updateLead;
    crm.updateLead = async (...args) => {
      if (fail) throw new Error('Network error: fetch failed');
      return update(...args);
    };
    const o = new Orchestrator({ crm, whatsapp: { async reply() { return true; } } });

    repo.dmThreads.upsert(CHAT, '+919000000077');
    repo.dmThreads.setCrmLead(CHAT, 'LEAD');
    repo.dmMessages.create({ waMessageId: 'f1', chatId: CHAT, direction: 'out', body: assistant.DM_DETAILS[1] });

    await o.noteDmEnquiryType(CHAT);
    assert.equal(writes.updates.length, 0);
    assert.equal(writes.remarks.length, 0, 'nothing is marked done until the field is in');

    fail = false;
    await o.noteDmEnquiryType(CHAT);
    await o.noteDmEnquiryType(CHAT);
    assert.deepEqual(writes.updates, [['LEAD', { enquiry_type: 'channel_partner' }]]);
    assert.equal(writes.remarks.length, 1);
  });

  test('leads that chose before the field existed are backfilled, once', async (t) => {
    useScript(t);
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();

    // Chose option 1 last week: has the remark, but not the field.
    repo.dmThreads.upsert(CHAT, '+919000000077');
    repo.dmThreads.setCrmLead(CHAT, 'OLD-1');
    repo.dmThreads.setCaptured(CHAT, { enquiry_type_remark: true });
    repo.dmMessages.create({ waMessageId: 'b1', chatId: CHAT, direction: 'out', body: assistant.DM_DETAILS[1] });

    // Old-script lead: never saw the menu, so there is nothing to fill in.
    const OLD = '919000000099@s.whatsapp.net';
    repo.dmThreads.upsert(OLD, '+919000000099');
    repo.dmThreads.setCrmLead(OLD, 'OLD-2');
    repo.dmMessages.create({ waMessageId: 'b2', chatId: OLD, direction: 'out', body: assistant.PREVIOUS_DM_DETAILS_REQUEST });

    const { crm, writes } = recordingCrm();
    const o = new Orchestrator({ crm, whatsapp: { async reply() { return true; } } });

    assert.equal(await o.backfillEnquiryTypes(), 1);
    assert.deepEqual(writes.updates, [['OLD-1', { enquiry_type: 'channel_partner' }]]);
    assert.equal(writes.remarks.length, 0, 'the remark is already there');

    assert.equal(await o.backfillEnquiryTypes(), 0, 'the second run does nothing');
    assert.equal(writes.updates.length, 1);
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

    assert.deepEqual(sends, [assistant.DM_GREETING], 'after a reset it greets them again');
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

  test('it waits before replying', async (t) => {
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

    assert.equal(at.length, 1);
    assert.ok(at[0] >= 120, `the reply came after ${at[0]}ms, expected a pause`);
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

describe('dealer and brand answers', () => {
  const { coerce } = require('../src/pipeline/labels');
  const fields = require('../src/crm/fields');
  const extract = require('../src/ai/extract');

  test('both are fields the bot may read from a reply, and send', () => {
    assert.ok('is_existing_dealer' in extract.EXTRACTABLE);
    assert.ok('current_brand' in extract.EXTRACTABLE);
    for (const f of ['enquiry_type', 'is_existing_dealer', 'current_brand']) {
      assert.ok(fields.CREATE_FIELDS.has(f) && fields.UPDATE_FIELDS.has(f), f);
    }
  });

  test('"are you a dealer" takes only a clear yes or no', () => {
    assert.deepEqual(coerce('is_existing_dealer', 'Yes'), { ok: true, value: true });
    assert.deepEqual(coerce('is_existing_dealer', 'nahi'), { ok: true, value: false });
    assert.equal(coerce('is_existing_dealer', 'maybe later').ok, false);
  });

  test('enquiry_type takes only the two values the CRM accepts', () => {
    assert.deepEqual(coerce('enquiry_type', 'channel_partner'), { ok: true, value: 'channel_partner' });
    assert.equal(coerce('enquiry_type', 'dealer').ok, false);
  });

  test('a brand name is kept as written, within the CRM limit', () => {
    assert.deepEqual(coerce('current_brand', ' Luminous '), { ok: true, value: 'Luminous' });
    assert.equal(fields.MAX_LENGTH.current_brand, 100);
  });
});
