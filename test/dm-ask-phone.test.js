/**
 * A customer whose number WhatsApp hides is asked for it, once, and the lead
 * is created from what they type.
 */
const { test, describe, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-dm-ask-phone.db');
process.env.DB_PATH = TEST_DB;

const openrouter = require('../src/ai/openrouter');
const db = require('../src/db');
const repo = require('../src/db/repositories');
const { config } = require('../src/config');
const { normalise } = require('../src/whatsapp/messages');
const { Orchestrator } = require('../src/pipeline/orchestrator');
const assistant = require('../src/ai/assistant');

const LID_CHAT = '10000000000099@lid';        // made up — no number alongside it
const PN_CHAT = '919000000078@s.whatsapp.net'; // made up — number known

/** A CRM double: records every call, answers each with something harmless. */
function fakeCrm() {
  const calls = [];
  const answers = {
    findByPhone: async () => ({ status: 'none', lead: null }),
    createLead: async (fields) => ({ lead: { id: 'lead-1', ...fields }, deferred: {}, dropped: [] })
  };
  return new Proxy({ configured: true, calls }, {
    get(target, name) {
      if (name in target) return target[name];
      if (typeof name !== 'string' || name === 'then') return undefined;
      return async (...args) => {
        calls.push([name, ...args]);
        return answers[name] ? answers[name](...args) : {};
      };
    }
  });
}

async function converse(chatId, lines) {
  db.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
  db.init();

  const sends = [];
  const crm = fakeCrm();
  const o = new Orchestrator({ crm, whatsapp: { async reply({ text }) { sends.push(text); return true; } } });

  for (const [i, text] of lines.entries()) {
    await o.handleDirect(normalise({
      key: { id: 'ap' + i, remoteJid: chatId, fromMe: false },
      message: { conversation: text }, messageTimestamp: 1
    }));
    await o.settled();
  }
  return { sends, crm };
}

describe('asking for a hidden phone number', () => {
  function useScript(t) {
    const before = { mode: config.ai.dmMode, menu: config.ai.dmMenu,
      delay: config.ai.replyDelayMs, gap: config.ai.replyGapMs };
    config.ai.dmMode = 'script';
    config.ai.dmMenu = 'text';
    config.ai.replyDelayMs = 0;
    config.ai.replyGapMs = 0;
    // The CRM half reads typed fields with the model; not under test here.
    mock.method(openrouter, 'chat', async () => null);
    t.after(() => {
      Object.assign(config.ai, { dmMode: before.mode, dmMenu: before.menu,
        replyDelayMs: before.delay, replyGapMs: before.gap });
      mock.restoreAll(); db.close();
      for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    });
  }

  test('asked once, after the greeting; the script still runs to the end', async (t) => {
    useScript(t);
    const { sends } = await converse(LID_CHAT, ['Hi', '1', 'Amit\nPune\n5 kW\n4 hours', 'thanks']);

    assert.deepEqual(sends, [
      assistant.DM_GREETING,
      assistant.DM_DETAILS[1],
      assistant.DM_ASK_PHONE,
      assistant.DM_CLOSING
    ]);
  });

  test('the typed number creates the lead', async (t) => {
    useScript(t);
    const { sends, crm } = await converse(LID_CHAT,
      ['Hi', '2', 'My number is 98765 43210\nAmit\nPune\nAcme\nNo\n-']);

    assert.equal(repo.dmThreads.byChatId(LID_CHAT).phone, '+919876543210');
    const create = crm.calls.find(([name]) => name === 'createLead');
    assert.ok(create, 'a lead was created');
    assert.equal(create[1].phone, '+919876543210');
    assert.equal(repo.dmThreads.byChatId(LID_CHAT).crm_lead_id, 'lead-1');
    assert.equal(sends.at(-1), assistant.DM_CLOSING);
  });

  test('no lead before they answer', async (t) => {
    useScript(t);
    const { crm } = await converse(LID_CHAT, ['Hi', '1']);
    assert.equal(repo.dmThreads.byChatId(LID_CHAT).phone, null);
    assert.equal(crm.calls.filter(([name]) => name === 'createLead').length, 0);
  });

  test('a number typed before the bot asked is not taken', async (t) => {
    // Without the question, "9876543210" could be anyone's — a brother's, a
    // dealer they were told to call. The question is what makes it theirs.
    useScript(t);
    await converse(LID_CHAT, ['Call my brother on 9876543210']);
    assert.equal(repo.dmThreads.byChatId(LID_CHAT).phone, null);
  });

  test('two numbers in one answer are not guessed between', async (t) => {
    useScript(t);
    await converse(LID_CHAT, ['Hi', '1', '9876543210 or 9123456780']);
    assert.equal(repo.dmThreads.byChatId(LID_CHAT).phone, null);
  });

  test('never asked when WhatsApp gave the number', async (t) => {
    useScript(t);
    const { sends } = await converse(PN_CHAT, ['Hi', '1', 'Amit\nPune\n5 kW\n4 hours']);
    assert.ok(!sends.includes(assistant.DM_ASK_PHONE));
  });

  test('never asked in a chat the script did not start', async (t) => {
    // e.g. the team already talking to them from the phone, before this script.
    useScript(t);
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();
    repo.dmThreads.upsert(LID_CHAT, null);
    repo.dmMessages.create({ waMessageId: 'team-1', chatId: LID_CHAT, direction: 'out', body: 'Hello sir, sharing the brochure' });

    const sends = [];
    const o = new Orchestrator({ crm: { configured: false },
      whatsapp: { async reply({ text }) { sends.push(text); return true; } } });
    await o.handleDirect(normalise({
      key: { id: 'x1', remoteJid: LID_CHAT, fromMe: false },
      message: { conversation: 'ok thanks' }, messageTimestamp: 1
    }));
    await o.settled();
    assert.deepEqual(sends, []);
  });
});
