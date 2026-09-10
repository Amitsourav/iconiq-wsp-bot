const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-dm-sync.db');
process.env.DB_PATH = TEST_DB;

const db = require('../src/db');
const repo = require('../src/db/repositories');
const { DuplicateLeadError } = require('../src/crm/client');
const { syncDmConversations, extractName } = require('../src/pipeline/dmSync');

const CHAT = '919812345678@s.whatsapp.net';
const PHONE = '+919812345678';

/** A CRM double that records every call it receives. */
function fakeCrm(overrides = {}) {
  const calls = { findByPhone: [], createLead: [], addRemark: [], addLeadMessage: [] };
  return {
    configured: true,
    calls,
    async findByPhone(phone) {
      calls.findByPhone.push(phone);
      return overrides.findByPhone
        ? overrides.findByPhone(phone)
        : { status: 'none', lead: null };
    },
    async createLead(fields) {
      calls.createLead.push(fields);
      if (overrides.createLead) return overrides.createLead(fields);
      return { lead: { id: 'new-lead-id' }, deferred: {}, dropped: [] };
    },
    async addRemark(leadId, text) {
      calls.addRemark.push({ leadId, text });
      if (overrides.addRemark) return overrides.addRemark(leadId, text);
      return {};
    },
    // A chat now goes to the CRM's conversation view, one message at a time,
    // rather than being flattened into a single remark.
    async addLeadMessage(leadId, message) {
      calls.addLeadMessage.push({ leadId, ...message });
      if (overrides.addLeadMessage) return overrides.addLeadMessage(leadId, message);
      return {};
    }
  };
}

function seedMessages(chatId, lines) {
  repo.dmThreads.upsert(chatId, PHONE);
  lines.forEach(([direction, body], i) => {
    repo.dmMessages.create({
      waMessageId: `${chatId}-${i}`, chatId, direction, body
    });
  });
}

beforeEach(() => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  db.close();
  db.init();
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('dm_messages repository', () => {
  test('a redelivered message id is a no-op (wa_message_id UNIQUE)', () => {
    repo.dmThreads.upsert(CHAT, PHONE);
    const first = repo.dmMessages.create({ waMessageId: 'w1', chatId: CHAT, direction: 'in', body: 'hi' });
    const second = repo.dmMessages.create({ waMessageId: 'w1', chatId: CHAT, direction: 'in', body: 'hi again' });
    assert.ok(first);
    assert.equal(second, null);
    assert.equal(repo.dmMessages.unsyncedForChat(CHAT).length, 1);
  });

  test('upsert never overwrites a phone already on record', () => {
    repo.dmThreads.upsert(CHAT, PHONE);
    repo.dmThreads.upsert(CHAT, '+910000000000');
    assert.equal(repo.dmThreads.byChatId(CHAT).phone, PHONE);
  });

  test('chatsWithUnsynced only returns chats with something new', () => {
    seedMessages(CHAT, [['in', 'hello']]);
    assert.deepEqual(repo.dmMessages.chatsWithUnsynced(), [CHAT]);

    repo.dmMessages.markSynced(repo.dmMessages.unsyncedForChat(CHAT).map((r) => r.id));
    assert.deepEqual(repo.dmMessages.chatsWithUnsynced(), []);
  });
});

describe('extractName', () => {
  test('reads an explicit "Name:" label from the customer, never the bot', () => {
    const rows = [
      { direction: 'out', body: 'Name: Should Not Match' },
      { direction: 'in', body: 'Hi there' },
      { direction: 'in', body: 'Name: Rohit Verma' }
    ];
    assert.equal(extractName(rows), 'Rohit Verma');
  });

  test('returns null when nobody ever labelled a name', () => {
    assert.equal(extractName([{ direction: 'in', body: 'just chatting' }]), null);
  });
});

describe('syncDmConversations', () => {
  test('creates a lead (unassigned) and puts every message in the conversation view', async () => {
    seedMessages(CHAT, [
      ['in', 'Hi, tell me about your batteries'],
      ['out', 'Sure — we have 5.12 kWh to 161 kWh LFP options'],
      ['in', 'Name: Rohit Verma']
    ]);

    const crm = fakeCrm();
    const result = await syncDmConversations(crm);

    assert.deepEqual(result, { synced: 1, failed: 0 });
    assert.equal(crm.calls.createLead.length, 1);
    assert.equal(crm.calls.createLead[0].full_name, 'Rohit Verma');
    assert.equal(crm.calls.createLead[0].phone, PHONE);
    assert.equal(crm.calls.createLead[0].assigned_agent_id, undefined);

    // Each line of the chat is its own message, so the CRM inbox reads as a
    // conversation and shows who said what.
    const sent = crm.calls.addLeadMessage;
    assert.ok(sent.length >= 2, 'every message should reach the conversation view');
    assert.ok(sent.every((m) => m.leadId === 'new-lead-id'));
    assert.ok(sent.some((m) => /Hi, tell me about your batteries/.test(m.body)
      && m.isOurTeam === false));
    assert.ok(sent.some((m) => /5\.12 kWh to 161 kWh/.test(m.body) && m.isOurTeam === true));
    // wa_message_id is what makes a retry harmless.
    assert.ok(sent.every((m) => m.waMessageId));

    const thread = repo.dmThreads.byChatId(CHAT);
    assert.equal(thread.status, 'synced');
    assert.equal(thread.crm_lead_id, 'new-lead-id');
    assert.equal(repo.dmMessages.chatsWithUnsynced().length, 0);
  });

  test('falls back to the phone number as the name when nobody gave one', async () => {
    seedMessages(CHAT, [['in', 'just browsing']]);
    const crm = fakeCrm();
    await syncDmConversations(crm);
    assert.equal(crm.calls.createLead[0].full_name, PHONE);
  });

  test('an existing lead gets a remark, never a second lead', async () => {
    seedMessages(CHAT, [['in', 'question two']]);
    const crm = fakeCrm({
      findByPhone: async () => ({ status: 'found', lead: { id: 'existing-lead' } })
    });

    await syncDmConversations(crm);

    assert.equal(crm.calls.createLead.length, 0);
    assert.equal(crm.calls.addLeadMessage[0].leadId, 'existing-lead');
    assert.equal(repo.dmThreads.byChatId(CHAT).crm_lead_id, 'existing-lead');
  });

  test('a known crm_lead_id from a prior sync skips the phone search entirely', async () => {
    seedMessages(CHAT, [['in', 'day two message']]);
    repo.dmThreads.setCrmLead(CHAT, 'already-linked');

    const crm = fakeCrm();
    await syncDmConversations(crm);

    assert.equal(crm.calls.findByPhone.length, 0);
    assert.equal(crm.calls.createLead.length, 0);
    assert.equal(crm.calls.addLeadMessage[0].leadId, 'already-linked');
  });

  test('C5 — an ambiguous phone match is held, never guessed', async () => {
    seedMessages(CHAT, [['in', 'hello']]);
    const crm = fakeCrm({
      findByPhone: async () => ({ status: 'ambiguous', lead: null, candidates: 2 })
    });

    const result = await syncDmConversations(crm);

    assert.deepEqual(result, { synced: 0, failed: 1 });
    assert.equal(crm.calls.createLead.length, 0);
    assert.equal(crm.calls.addLeadMessage.length, 0);

    const thread = repo.dmThreads.byChatId(CHAT);
    assert.equal(thread.status, 'ambiguous');
    // Left unsynced deliberately, so the next run retries rather than losing it.
    assert.equal(repo.dmMessages.chatsWithUnsynced().length, 1);
  });

  test('B2 — a duplicate-lead error recovers using the id the CRM gave back', async () => {
    seedMessages(CHAT, [['in', 'hello again']]);
    let attempt = 0;
    const crm = fakeCrm({
      findByPhone: async () => ({ status: 'none', lead: null }),
      createLead: async () => {
        throw new DuplicateLeadError({ existing_lead_id: 'dup-lead', existing_lead_name: 'X' });
      },
      addLeadMessage: async (leadId) => {
        attempt += 1;
        return { leadId };
      }
    });

    const result = await syncDmConversations(crm);

    assert.deepEqual(result, { synced: 1, failed: 0 });
    assert.equal(attempt, 1);
    assert.equal(crm.calls.addLeadMessage[0].leadId, 'dup-lead');
    assert.equal(repo.dmThreads.byChatId(CHAT).crm_lead_id, 'dup-lead');
  });

  test('a hard CRM failure marks the thread failed and leaves messages unsynced for retry', async () => {
    seedMessages(CHAT, [['in', 'hello']]);
    const crm = fakeCrm({
      findByPhone: async () => { throw new Error('CRM unreachable'); }
    });

    const result = await syncDmConversations(crm);

    assert.deepEqual(result, { synced: 0, failed: 1 });
    const thread = repo.dmThreads.byChatId(CHAT);
    assert.equal(thread.status, 'failed');
    assert.match(thread.last_error, /CRM unreachable/);
    assert.equal(repo.dmMessages.chatsWithUnsynced().length, 1);
  });

  test('does nothing when the CRM is not configured', async () => {
    seedMessages(CHAT, [['in', 'hello']]);
    const result = await syncDmConversations({ configured: false });
    assert.deepEqual(result, { synced: 0, failed: 0 });
    assert.equal(repo.dmMessages.chatsWithUnsynced().length, 1);
  });

  test('two separate chats are synced independently', async () => {
    const chat2 = '919999999999@s.whatsapp.net';
    seedMessages(CHAT, [['in', 'chat one']]);
    seedMessages(chat2, [['in', 'chat two']]);

    const crm = fakeCrm();
    const result = await syncDmConversations(crm);

    assert.deepEqual(result, { synced: 2, failed: 0 });
    assert.equal(crm.calls.createLead.length, 2);
  });
});
