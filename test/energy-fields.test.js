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
