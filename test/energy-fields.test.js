/**
 * The Iconiq Energy fields, and the DM lead being created on first contact.
 *
 * Both exist because of the same discovery: the CRM had energy columns
 * (load, backup, solar, DG) that this client did not know about, so it stripped
 * them and the CRM answered 201 while discarding them (C10). Nothing anywhere
 * reported the loss — which is exactly the failure these tests exist to catch if
 * the field map ever drifts from the CRM again.
 */
const { test, describe, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-energy.db');
process.env.DB_PATH = TEST_DB;

const db = require('../src/db');
const repo = require('../src/db/repositories');
const labelParser = require('../src/pipeline/labels');
const { CrmClient } = require('../src/crm/client');
const { ensureCrmLead } = require('../src/pipeline/dmSync');
const { RetryWorker } = require('../src/pipeline/worker');

const CHAT = '919812345000@s.whatsapp.net';
const PHONE = '+919812345000';

describe('energy labels', () => {
  test('every energy field can be set from a WhatsApp label', () => {
    const { fields } = labelParser.parse([
      'Company: Acme Industries',
      'Website: https://acme.example',
      'Industry: Manufacturing',
      'Load: 10 kW',
      'Backup: 4 hours',
      'Solar: yes',
      'Solar Capacity: 5',
      'DG: yes',
      'DG Capacity: 15'
    ].join('\n'));

    assert.equal(fields.organization, 'Acme Industries');
    assert.equal(fields.website, 'https://acme.example');
    assert.equal(fields.application_industry, 'Manufacturing');
    assert.equal(fields.load_capacity_kw, 10);
    assert.equal(fields.backup_duration_hours, 4);
    assert.equal(fields.solar_present, true);
    assert.equal(fields.solar_capacity_kw, 5);
    assert.equal(fields.dg_available, true);
    assert.equal(fields.dg_capacity_kva, 15);
  });

  test('a plain no is false, not a missing field', () => {
    const { fields } = labelParser.parse('Solar: no\nDG: nahi');
    assert.equal(fields.solar_present, false);
    assert.equal(fields.dg_available, false);
  });

  test('a capacity is NOT an answer to a yes/no question', () => {
    // "Solar: 5kW" must not be read as "yes, they have solar" — a size is not a
    // statement that it exists. It goes to remarks instead, where a human reads it.
    const { fields, rejected } = labelParser.parse('Solar: 5kW');
    assert.equal(fields.solar_present, undefined);
    assert.equal(rejected[0].reason, 'not_yes_or_no');
  });

  test('words are never quietly turned into a zero', () => {
    // Stripping non-digits leaves "", and Number("") is 0 — so this once wrote
    // a load of zero for "a big load". An empty field is recoverable; a wrong
    // number in the CRM is not, because nobody knows to doubt it.
    for (const text of ['Load: a big load', 'Backup: few hours', 'Percentage: abc']) {
      const { fields, rejected } = labelParser.parse(text);
      assert.deepEqual(fields, {}, `${text} should set nothing`);
      assert.equal(rejected[0].reason, 'not_a_number');
    }
  });

  test('a target month is anchored to a real date', () => {
    // The CRM validates expected_closure_month as a date and rejects "2026-10"
    // outright, confirmed live against the API.
    assert.equal(labelParser.parse('Timeline: 2026-10').fields.expected_closure_month,
      '2026-10-01');
    assert.equal(labelParser.parse('Timeline: Oct 2026').fields.expected_closure_month,
      '2026-10-01');
  });

  test('nobody can set the lead source or the assignee by typing it', () => {
    // LABEL_FORBIDDEN — reassigning a lead by writing a line must stay impossible.
    const { fields } = labelParser.parse('Lead Source: WhatsApp\nPhone: 9999999999');
    assert.equal(fields.lead_source_id, undefined);
    assert.equal(fields.phone, undefined);
  });
});

describe('the CRM client keeps the energy fields', () => {
  const crm = new CrmClient({ baseUrl: 'http://example.invalid', apiKey: 'k' });

  const energy = {
    organization: 'Acme', website: 'https://a.example',
    application_industry: 'Manufacturing', load_capacity_kw: 10,
    backup_duration_hours: 4, solar_present: true, solar_capacity_kw: 5,
    dg_available: false, dg_capacity_kva: 15, expected_closure_month: '2026-10-01'
  };

  test('none of them are dropped on create', () => {
    const { payload, dropped } = crm.sanitise({ full_name: 'A', ...energy }, 'create');
    assert.deepEqual(dropped, []);
    for (const field of Object.keys(energy)) {
      assert.ok(field in payload, `${field} was dropped on create`);
    }
  });

  test('none of them are dropped on update either', () => {
    const { payload } = crm.sanitise(energy, 'update');
    for (const field of Object.keys(energy)) {
      assert.ok(field in payload, `${field} was dropped on update`);
    }
  });

  test('phone is still refused on update (C3)', () => {
    const { payload, dropped } = crm.sanitise({ phone: '+919812345000', ...energy }, 'update');
    assert.equal(payload.phone, undefined);
    assert.equal(dropped.find((d) => d.field === 'phone').reason, 'update_forbidden');
  });
});

describe('a DM lead is created on first contact', () => {
  beforeEach(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(TEST_DB + suffix, { force: true });
    }
    db.init();
  });

  after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(TEST_DB + suffix, { force: true });
    }
  });

  const fakeCrm = (overrides = {}) => ({
    configured: true,
    calls: { createLead: [] },
    async findByPhone() {
      return overrides.findByPhone ? overrides.findByPhone() : { status: 'none', lead: null };
    },
    async createLead(fields) {
      this.calls.createLead.push(fields);
      if (overrides.createLead) return overrides.createLead(fields);
      return { lead: { id: 'lead-1' }, deferred: {}, dropped: [] };
    }
  });

  test('the lead exists immediately, unassigned, named by its number', async () => {
    const crm = fakeCrm();
    const thread = repo.dmThreads.upsert(CHAT, PHONE);

    const result = await ensureCrmLead(crm, thread);

    assert.equal(result.status, 'ok');
    assert.equal(result.leadId, 'lead-1');
    assert.equal(repo.dmThreads.byChatId(CHAT).crm_lead_id, 'lead-1');

    const sent = crm.calls.createLead[0];
    assert.equal(sent.full_name, PHONE, 'the phone stands in as the name');
    // Nobody is silently made the owner of a chat that has no employee behind it.
    assert.equal(sent.assigned_agent_id, undefined);
  });

  test('calling it again never creates a second lead', async () => {
    const crm = fakeCrm();
    await ensureCrmLead(crm, repo.dmThreads.upsert(CHAT, PHONE));
    await ensureCrmLead(crm, repo.dmThreads.byChatId(CHAT));
    assert.equal(crm.calls.createLead.length, 1);
  });

  test('two leads on one number is held for a human, never guessed', async () => {
    const crm = fakeCrm({ findByPhone: () => ({ status: 'ambiguous', candidates: 2 }) });
    const result = await ensureCrmLead(crm, repo.dmThreads.upsert(CHAT, PHONE));

    assert.equal(result.status, 'ambiguous');
    assert.equal(crm.calls.createLead.length, 0);
    assert.equal(repo.dmThreads.byChatId(CHAT).status, 'ambiguous');
  });

  test('an ambiguous chat is not retried in a loop', () => {
    repo.dmThreads.upsert(CHAT, PHONE);
    repo.dmThreads.markAmbiguous(CHAT, '2 leads share this phone');
    assert.equal(repo.dmThreads.awaitingLead().length, 0);
  });

  test('a CRM outage delays the lead, it never loses it', async () => {
    let down = true;
    const crm = {
      configured: true,
      async findByPhone() {
        if (down) throw new Error('Network error');
        return { status: 'none', lead: null };
      },
      async createLead() {
        if (down) throw new Error('Network error');
        return { lead: { id: 'recovered' }, deferred: {}, dropped: [] };
      }
    };

    repo.dmThreads.upsert(CHAT, PHONE);
    const worker = new RetryWorker({ orchestrator: { crm } });

    await worker.retryDmLeads();
    assert.equal(repo.dmThreads.byChatId(CHAT).crm_lead_id, null);
    assert.equal(repo.dmThreads.byChatId(CHAT).attempts, 1);

    down = false;
    // The backoff would hold it for a minute; pretend that minute has passed.
    db.get().prepare(
      "UPDATE dm_threads SET updated_at = datetime('now','-10 minutes') WHERE chat_id = ?"
    ).run(CHAT);

    await worker.retryDmLeads();
    assert.equal(repo.dmThreads.byChatId(CHAT).crm_lead_id, 'recovered');
  });

  test('captured fields are written once, not on every message', async () => {
    const openrouter = require('../src/ai/openrouter');
    const { Orchestrator } = require('../src/pipeline/orchestrator');

    const updates = [];
    const crm = {
      configured: true,
      async findByPhone() { return { status: 'none', lead: null }; },
      async createLead() { return { lead: { id: 'lead-x' }, deferred: {}, dropped: [] }; },
      async updateLead(id, fields) { updates.push(fields); return { lead: null, dropped: [] }; }
    };

    repo.dmThreads.upsert(CHAT, PHONE);
    repo.dmThreads.setCrmLead(CHAT, 'lead-x');
    repo.dmMessages.create({
      waMessageId: 'm1', chatId: CHAT, direction: 'in', body: '10kw factory pune'
    });

    mock.method(openrouter, 'chat', async () => JSON.stringify({
      city: 'Pune', load_capacity_kw: 10
    }));

    const orchestrator = new Orchestrator({ crm, whatsapp: {} });

    await orchestrator.captureDmFields(CHAT);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { city: 'Pune', load_capacity_kw: 10 });

    // The model repeats the same facts next message; nothing should be resent.
    await orchestrator.captureDmFields(CHAT);
    assert.equal(updates.length, 1, 'an unchanged value must not be rewritten');

    assert.deepEqual(repo.dmThreads.captured(CHAT), { city: 'Pune', load_capacity_kw: 10 });
    mock.restoreAll();
  });

  test('a chat with no readable number waits rather than making a junk lead', async () => {
    const crm = fakeCrm();
    const thread = repo.dmThreads.upsert('nophone@s.whatsapp.net', null);

    const result = await ensureCrmLead(crm, thread);

    assert.equal(result.status, 'no_phone');
    assert.equal(crm.calls.createLead.length, 0);
  });
});

describe('LID addressing is never mistaken for a phone number', () => {
  const { normalise } = require('../src/whatsapp/messages');
  const phoneUtil = require('../src/pipeline/phone');

  test('a LID is not a phone number', () => {
    // "79955161551055@lid" reads as a valid foreign E.164 if you just take the
    // digits — which is how a lead reached the CRM as "+79955161551055".
    assert.equal(phoneUtil.fromJidInternational('79955161551055@lid'), null);
    assert.equal(phoneUtil.fromJid('79955161551055@lid'), null);
    assert.equal(phoneUtil.isLid('79955161551055@lid'), true);
  });

  test('a real number JID still resolves', () => {
    assert.equal(phoneUtil.fromJidInternational('919812345000@s.whatsapp.net'),
      '+919812345000');
    assert.equal(phoneUtil.fromJidInternational('96569950748@s.whatsapp.net'),
      '+96569950748');
  });

  test('a DM over LID uses the real number WhatsApp sends alongside', () => {
    const message = normalise({
      key: {
        id: 'm1',
        remoteJid: '79955161551055@lid',
        senderPn: '919812345000@s.whatsapp.net',
        fromMe: false
      },
      message: { conversation: 'hi' },
      messageTimestamp: 1
    });

    assert.equal(message.senderPhone, '+919812345000');
    assert.equal(message.senderPnJid, '919812345000@s.whatsapp.net');
    // The reply goes to the number, not the LID — a @lid reply can vanish.
    assert.equal(message.replyTo, '919812345000@s.whatsapp.net');
    // The chat is still identified by its LID, so the thread stays one thread.
    assert.equal(message.chatId, '79955161551055@lid');
  });

  test('a group message prefers participantPn over the LID', () => {
    const message = normalise({
      key: {
        id: 'm2',
        remoteJid: '120363000000000000@g.us',
        participant: '2807000000000@lid',
        participantPn: '919812345000@s.whatsapp.net',
        fromMe: false
      },
      message: { conversation: 'hello' },
      messageTimestamp: 1
    });

    assert.equal(message.senderPhone, '+919812345000');
    // A group is always answered in the group.
    assert.equal(message.replyTo, '120363000000000000@g.us');
  });

  test('a LID with no number beside it yields no phone, not a fake one', () => {
    const message = normalise({
      key: { id: 'm3', remoteJid: '79955161551055@lid', fromMe: false },
      message: { conversation: 'hi' },
      messageTimestamp: 1
    });

    assert.equal(message.senderPhone, null);
    assert.equal(phoneUtil.fromJidInternational(message.senderPnJid || message.chatId),
      null);
  });
});

describe('a chat we cannot identify is visible, and recovers on its own', () => {
  const ANON = '79955161551055@lid';

  beforeEach(() => {
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();
  });

  test('a chat with no number is listed rather than lost', () => {
    repo.dmThreads.upsert(ANON, null);
    repo.dmMessages.create({
      waMessageId: 'a1', chatId: ANON, direction: 'in', body: 'Hi'
    });
    repo.dmMessages.create({
      waMessageId: 'a2', chatId: ANON, direction: 'out', body: 'greeting'
    });
    repo.dmMessages.create({
      waMessageId: 'a3', chatId: ANON, direction: 'in', body: 'I need 10kw'
    });

    const [chat] = repo.dmThreads.unidentified();

    assert.equal(chat.chat_id, ANON);
    assert.equal(chat.message_count, 3);
    // The newest thing the CUSTOMER said, so it can be acted on without opening
    // WhatsApp — not the bot's own last reply.
    assert.equal(chat.last_inbound, 'I need 10kw');
  });

  test('an identified chat is not listed', () => {
    repo.dmThreads.upsert('919812345000@s.whatsapp.net', '+919812345000');
    assert.equal(repo.dmThreads.unidentified().length, 0);
  });

  test('a number arriving on a later message fills the blank', () => {
    repo.dmThreads.upsert(ANON, null);
    assert.equal(repo.dmThreads.byChatId(ANON).phone, null);

    const filled = repo.dmThreads.setPhone(ANON, '+919812345000');

    assert.equal(filled, true, 'the number should have been recorded');
    assert.equal(repo.dmThreads.byChatId(ANON).phone, '+919812345000');
    assert.equal(repo.dmThreads.unidentified().length, 0, 'it should no longer need attention');
  });

  test('a number already recorded is never rewritten', () => {
    // The phone is the lead's identity (C3). A later message must not be able to
    // move an existing lead onto a different number.
    repo.dmThreads.upsert(ANON, '+919812345000');

    const changed = repo.dmThreads.setPhone(ANON, '+919999999999');

    assert.equal(changed, false);
    assert.equal(repo.dmThreads.byChatId(ANON).phone, '+919812345000');
  });

  test('once identified, the retry worker picks it up for a lead', () => {
    repo.dmThreads.upsert(ANON, null);
    // No number means nothing to look up, so it is not queued.
    assert.equal(repo.dmThreads.awaitingLead().length, 0);

    repo.dmThreads.setPhone(ANON, '+919812345000');

    assert.equal(repo.dmThreads.awaitingLead().length, 1,
      'a chat that just became identifiable should be queued for a lead');
  });
});

describe('a lead is named, not just numbered', () => {
  const { normalise } = require('../src/whatsapp/messages');
  const CHAT2 = '919812345111@s.whatsapp.net';

  beforeEach(() => {
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();
  });

  test('the WhatsApp profile name is read off the message', () => {
    const m = normalise({
      key: { id: 'p1', remoteJid: CHAT2, fromMe: false },
      pushName: 'Suresh Menon',
      message: { conversation: 'hi' },
      messageTimestamp: 1
    });
    assert.equal(m.pushName, 'Suresh Menon');
  });

  test('a profile name fills a blank', () => {
    repo.dmThreads.upsert(CHAT2, '+919812345111');
    assert.equal(repo.dmThreads.setNameIfBlank(CHAT2, 'Suresh Menon'), true);
    assert.equal(repo.dmThreads.byChatId(CHAT2).name, 'Suresh Menon');
  });

  test('a profile name never displaces a name they actually gave us', () => {
    // The profile name arrives on every single message, so an overwriting
    // version would undo the good name on the very next one.
    repo.dmThreads.upsert(CHAT2, '+919812345111');
    repo.dmThreads.setName(CHAT2, 'Suresh Menon');

    assert.equal(repo.dmThreads.setNameIfBlank(CHAT2, '😎 King'), false);
    assert.equal(repo.dmThreads.byChatId(CHAT2).name, 'Suresh Menon');
  });

  test('a stated name does replace a profile name', () => {
    repo.dmThreads.upsert(CHAT2, '+919812345111');
    repo.dmThreads.setNameIfBlank(CHAT2, '😎 King');
    repo.dmThreads.setName(CHAT2, 'Suresh Menon');
    assert.equal(repo.dmThreads.byChatId(CHAT2).name, 'Suresh Menon');
  });

  test('the lead is created under the name, not the phone number', async () => {
    const created = [];
    const crm = {
      configured: true,
      async findByPhone() { return { status: 'none', lead: null }; },
      async createLead(f) { created.push(f); return { lead: { id: 'l1' }, deferred: {}, dropped: [] }; }
    };

    repo.dmThreads.upsert(CHAT2, '+919812345111');
    repo.dmThreads.setNameIfBlank(CHAT2, 'Suresh Menon');

    await ensureCrmLead(crm, repo.dmThreads.byChatId(CHAT2));

    assert.equal(created[0].full_name, 'Suresh Menon',
      'the CRM should not become a list of phone numbers');
  });

  test('still falls back to the number when nobody has a name', async () => {
    const created = [];
    const crm = {
      configured: true,
      async findByPhone() { return { status: 'none', lead: null }; },
      async createLead(f) { created.push(f); return { lead: { id: 'l2' }, deferred: {}, dropped: [] }; }
    };

    repo.dmThreads.upsert(CHAT2, '+919812345111');
    await ensureCrmLead(crm, repo.dmThreads.byChatId(CHAT2));

    assert.equal(created[0].full_name, '+919812345111');
  });
});

describe('one chat is handled one message at a time', () => {
  const { Orchestrator } = require('../src/pipeline/orchestrator');

  const idleCrm = { configured: false };

  test('a second message waits for the first to finish', async () => {
    // Overlapping handling meant overlapping sends, and two sends racing on one
    // conversation put its encryption ratchet out of order — after which the
    // recipient could not decrypt anything and saw "Waiting for this message".
    const o = new Orchestrator({ crm: idleCrm, whatsapp: {} });
    const order = [];

    const slow = o.serialise('chat-a', async () => {
      order.push('first:start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('first:end');
    });
    const quick = o.serialise('chat-a', async () => {
      order.push('second:start');
    });

    await Promise.all([slow, quick]);

    assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
  });

  test('different chats still run at the same time', async () => {
    const o = new Orchestrator({ crm: idleCrm, whatsapp: {} });
    const order = [];

    const a = o.serialise('chat-a', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('a');
    });
    const b = o.serialise('chat-b', async () => {
      order.push('b');
    });

    await Promise.all([a, b]);

    // b finished first despite being queued second — one slow customer must not
    // hold up everyone else.
    assert.deepEqual(order, ['b', 'a']);
  });

  test('a failed message does not block the rest of the chat', async () => {
    const o = new Orchestrator({ crm: idleCrm, whatsapp: {} });
    let ran = false;

    await o.serialise('chat-c', async () => { throw new Error('boom'); })
      .catch(() => {});
    await o.serialise('chat-c', async () => { ran = true; });

    assert.equal(ran, true);
  });

  test('the queue does not grow forever', async () => {
    const o = new Orchestrator({ crm: idleCrm, whatsapp: {} });
    await o.serialise('chat-d', async () => {});
    await new Promise((r) => setImmediate(r));
    assert.equal(o.chatQueues.has('chat-d'), false);
  });
});

describe('the conversation view keeps up with the conversation', () => {
  const { Orchestrator } = require('../src/pipeline/orchestrator');
  const CHAT3 = '919311359236@s.whatsapp.net';

  beforeEach(() => {
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();
  });

  test('messages sent after the lead exists still reach the CRM', async () => {
    // The push used to live inside ensureDmLead, which returns early once a
    // thread has a lead — so only the messages present at creation were ever
    // sent. The CRM showed the greeting and nothing the customer said after.
    const sent = [];
    const crm = {
      configured: true,
      async findByPhone() { return { status: 'none', lead: null }; },
      async createLead() { return { lead: { id: 'lead-9' }, deferred: {}, dropped: [] }; },
      async addLeadMessage(leadId, m) { sent.push(m.body); return {}; }
    };
    const o = new Orchestrator({ crm, whatsapp: { selfPhone: '919821152633' } });

    repo.dmThreads.upsert(CHAT3, '+919311359236');
    repo.dmMessages.create({
      waMessageId: 'm1', chatId: CHAT3, direction: 'in', body: 'Hi'
    });

    await o.ensureDmLead(CHAT3);
    await o.syncDmToCrm(CHAT3);
    assert.deepEqual(sent, ['Hi']);

    // The conversation continues after the lead already exists.
    repo.dmMessages.create({
      waMessageId: 'm2', chatId: CHAT3, direction: 'out', body: 'Thanks Amit!'
    });
    repo.dmMessages.create({
      waMessageId: 'm3', chatId: CHAT3, direction: 'in', body: 'Shop'
    });

    await o.ensureDmLead(CHAT3);
    await o.syncDmToCrm(CHAT3);

    assert.deepEqual(sent, ['Hi', 'Thanks Amit!', 'Shop'],
      'everything said after the lead was created must reach the CRM too');
  });

  test('a message is never sent to the CRM twice', async () => {
    const sent = [];
    const crm = {
      configured: true,
      async findByPhone() { return { status: 'found', lead: { id: 'lead-9' } }; },
      async addLeadMessage(leadId, m) { sent.push(m.body); return {}; }
    };
    const o = new Orchestrator({ crm, whatsapp: {} });

    repo.dmThreads.upsert(CHAT3, '+919311359236');
    repo.dmMessages.create({
      waMessageId: 'm1', chatId: CHAT3, direction: 'in', body: 'Hi'
    });

    await o.ensureDmLead(CHAT3);
    await o.syncDmToCrm(CHAT3);
    await o.syncDmToCrm(CHAT3);
    await o.syncDmToCrm(CHAT3);

    assert.deepEqual(sent, ['Hi']);
  });
});

describe('a reply is not held up by the CRM', () => {
  const { Orchestrator } = require('../src/pipeline/orchestrator');
  const { normalise } = require('../src/whatsapp/messages');
  const CHAT4 = '919000000044@s.whatsapp.net';

  beforeEach(() => {
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
    db.init();
  });

  test('the next reply goes out while the CRM work is still running', async (t) => {
    // Replies are off by default in tests, and the second turn would otherwise
    // make a real model call.
    const { config } = require('../src/config');
    const openrouter = require('../src/ai/openrouter');
    const before = { ...config.ai };
    config.ai.enabled = true;
    config.ai.replyInDms = true;
    config.ai.extractFields = false;
    mock.method(openrouter, 'chat', async () => 'ok');
    t.after(() => { Object.assign(config.ai, before); mock.restoreAll(); });

    // Only sending has to be ordered — two sends at once desync the chat's
    // encryption. The CRM is the slow part and touches nothing WhatsApp knows
    // about, so holding the next reply behind it just made customers wait.
    let crmBusy = 0;
    let sawSendDuringCrmWork = false;

    const crm = {
      configured: true,
      async findByPhone() { return { status: 'none', lead: null }; },
      async createLead() {
        crmBusy += 1;
        await new Promise((r) => setTimeout(r, 60));
        crmBusy -= 1;
        return { lead: { id: 'L1' }, deferred: {}, dropped: [] };
      },
      async addLeadMessage() { return {}; },
      async updateLead() { return { lead: null, dropped: [] }; }
    };

    const whatsapp = {
      selfPhone: '919821152633',
      async reply() {
        if (crmBusy > 0) sawSendDuringCrmWork = true;
        return true;
      }
    };

    const o = new Orchestrator({ crm, whatsapp });
    const say = (id, text) => normalise({
      key: { id, remoteJid: CHAT4, fromMe: false },
      message: { conversation: text }, messageTimestamp: 1
    });

    await o.handleDirect(say('n1', 'Hi'));
    await o.handleDirect(say('n2', 'anyone there?'));
    await o.settled();

    assert.equal(sawSendDuringCrmWork, true,
      'a reply should be able to go out while the CRM is still being written');
  });

  test('settled() waits for the background work', async (t) => {
    const { config } = require('../src/config');
    const before = { ...config.ai };
    config.ai.enabled = true;
    config.ai.replyInDms = true;
    config.ai.extractFields = false;
    t.after(() => Object.assign(config.ai, before));

    const created = [];
    const crm = {
      configured: true,
      async findByPhone() { return { status: 'none', lead: null }; },
      async createLead(f) { created.push(f); return { lead: { id: 'L1' }, deferred: {}, dropped: [] }; },
      async addLeadMessage() { return {}; },
      async updateLead() { return { lead: null, dropped: [] }; }
    };
    const o = new Orchestrator({ crm, whatsapp: { async reply() { return true; } } });

    await o.handleDirect(normalise({
      key: { id: 'n3', remoteJid: '919000000045@s.whatsapp.net', fromMe: false },
      message: { conversation: 'Hi' }, messageTimestamp: 1
    }));
    await o.settled();

    assert.equal(created.length, 1, 'the lead should exist once settled() returns');
  });
});
