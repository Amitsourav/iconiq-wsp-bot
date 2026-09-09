const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Point the database at a throwaway file before anything loads config.
const TEST_DB = path.join(__dirname, '..', 'data', 'test-orchestrator.db');
process.env.DB_PATH = TEST_DB;

const db = require('../src/db');
const repo = require('../src/db/repositories');
const { Orchestrator } = require('../src/pipeline/orchestrator');
const { DuplicateLeadError } = require('../src/crm/client');

const RAHUL_WA = '+919812345678';
const RAHUL_CRM = 'crm-profile-rahul';

/** A CRM double that records what it was asked to do. */
function fakeCrm(overrides = {}) {
  const calls = { created: [], updated: [], remarks: [], fetched: [] };
  return {
    calls,
    async createLead(fields) {
      calls.created.push(fields);
      if (overrides.createThrows) throw overrides.createThrows;
      return { lead: { id: 'crm-lead-1', ...fields }, deferred: overrides.deferred || {}, dropped: [] };
    },
    async updateLead(id, fields) {
      calls.updated.push({ id, fields });
      return { lead: { id, ...fields }, dropped: [] };
    },
    async addRemark(id, text, sourceId) {
      calls.remarks.push({ id, text, sourceId });
      return { id: 'remark-1' };
    },
    async findByPhone() {
      return overrides.existingByPhone
        ? { status: 'found', lead: overrides.existingByPhone }
        : { status: 'none', lead: null };
    },
    async getLead(id) {
      calls.fetched.push(id);
      return {
        id,
        current_stage: overrides.existingStage || 'contacted',
        full_name: overrides.existingName || 'Priya S',
        ...(overrides.currentFields || {})
      };
    }
  };
}

/** A WhatsApp double that records outgoing replies. */
function fakeWhatsApp() {
  const sent = [];
  return { sent, async reply(msg) { sent.push(msg); return true; } };
}

function makeGroup({ active = true, send = true, purpose = 'inhouse' } = {}) {
  const g = repo.groups.upsert('120363999@g.us', 'FMC In-House');
  repo.groups.setActive(g.id, active);
  repo.groups.setPurpose(g.id, purpose);
  repo.groups.setSendEnabled(g.id, send);
  return repo.groups.byWaId('120363999@g.us');
}

const incoming = (over = {}) => ({
  id: 'MSG-' + Math.random().toString(36).slice(2),
  groupId: '120363999@g.us',
  groupName: 'FMC In-House',
  isGroup: true,
  fromMe: false,
  senderPhone: '+919000000001',
  text: 'New lead @919812345678\nPriya Sharma\n9876543210',
  mentions: [RAHUL_WA],
  quotedId: null,
  timestamp: 1754400000,
  ...over
});

beforeEach(() => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  db.close();
  db.init();
  repo.employees.upsert({
    waPhone: RAHUL_WA, crmProfileId: RAHUL_CRM, name: 'Rahul Kumar', email: 'r@x.com'
  });
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('new lead — the happy path', () => {
  test('creates in the CRM, assigns the tagged employee, confirms in the group', async () => {
    const group = makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    assert.equal(crm.calls.created.length, 1);
    assert.equal(crm.calls.created[0].full_name, 'Priya Sharma');
    assert.equal(crm.calls.created[0].phone, '+919876543210');
    assert.equal(crm.calls.created[0].assigned_agent_id, RAHUL_CRM);

    assert.match(wa.sent[0].text, /Lead created/);
    assert.match(wa.sent[0].text, /Priya Sharma/);

    const stored = repo.leads.recent()[0];
    assert.equal(stored.status, 'created');
    assert.equal(stored.crm_lead_id, 'crm-lead-1');
    assert.equal(group.send_enabled, 1);
  });

  test('labelled fields ride along with the create', async () => {
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming({
      text: 'New lead @919812345678\nPriya Sharma\n9876543210\nUniversity: DU\nCourse: MBA'
    }));

    assert.equal(crm.calls.created[0].university, 'DU');
    assert.equal(crm.calls.created[0].target_degree, 'MBA');
  });

  test('update-only fields are patched after create, not lost (C11)', async () => {
    makeGroup();
    const crm = fakeCrm({ deferred: { loan_amount: '15 lakh' } });
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming());

    assert.equal(crm.calls.updated.length, 1);
    assert.deepEqual(crm.calls.updated[0].fields, { loan_amount: '15 lakh' });
  });

  test('unrecognised text is preserved as a remark', async () => {
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming({
      text: 'New lead @919812345678\nPriya Sharma\n9876543210\nvery keen, call after 6'
    }));

    assert.match(crm.calls.remarks[0].text, /very keen, call after 6/);
  });

  test('a redelivered message does nothing the second time', async () => {
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const msg = incoming();

    await o.handle(msg);
    await o.handle(msg);

    // WhatsApp replays messages after a reconnect; without the unique message id
    // this would be a second lead for the same person.
    assert.equal(crm.calls.created.length, 1);
  });
});

describe('leads that are held for a human', () => {
  test('no mention, number unknown → held and the group is asked to tag (Q6)', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(
      incoming({ text: 'Priya Sharma\n9876543210', mentions: [] })
    );

    assert.equal(crm.calls.created.length, 0, 'nothing should reach the CRM');
    assert.equal(repo.leads.held().length, 1, 'and nothing should be lost');
    assert.match(wa.sent[0].text, /Please tag the employee/);
  });

  test('no mention, but the number IS a lead → answer who owns it', async () => {
    // A number posted with no tag is usually the question "who has this one?".
    // Seen live: "78668 78035 / Existing lead. / Whoever the counsellor is please
    // call" — the bot had the answer and said nothing useful.
    makeGroup();
    const crm = fakeCrm({
      existingByPhone: {
        id: 'known-lead', serial_no: 4211, full_name: 'Ganpati Podder',
        current_stage: 'processing', assigned_agent_id: 'agent-9'
      }
    });
    crm.users = new Map([['agent-9', { id: 'agent-9', full_name: 'Zaid Ansari' }]]);

    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(
      incoming({ text: '78668 78035\nExisting lead.', mentions: [] })
    );

    assert.match(wa.sent[0].text, /Already in the CRM/);
    assert.match(wa.sent[0].text, /Counsellor: Zaid Ansari/, 'the question actually asked');
    assert.match(wa.sent[0].text, /Stage: Processing/);
    assert.equal(crm.calls.created.length, 0, 'must not create anything');
    assert.equal(repo.leads.recent()[0].status, 'existing');
  });

  test('two mentions → held with both names (Q9)', async () => {
    makeGroup();
    repo.employees.upsert({
      waPhone: '+919999888877', crmProfileId: 'p2', name: 'Priya Singh'
    });
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm: fakeCrm(), whatsapp: wa }).handle(incoming({
      mentions: [RAHUL_WA, '+919999888877']
    }));

    assert.match(wa.sent[0].text, /You tagged 2 people/);
    assert.match(wa.sent[0].text, /Rahul Kumar and Priya Singh/);
  });

  test('an unmapped employee → held, and the fix is named', async () => {
    makeGroup();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm: fakeCrm(), whatsapp: wa }).handle(incoming({
      text: 'New lead @919111111111\nPriya Sharma\n9876543210',
      mentions: ['+919111111111']
    }));

    assert.equal(repo.leads.held()[0].held_reason, 'unknown_employee');
    assert.match(wa.sent[0].text, /isn't set up as an employee/);
  });

  test('no name → created anyway, identified by its number', async () => {
    // Phone is the identity; a lead shared as just a number is complete.
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming({
      text: 'New lead @919812345678\n9876543210'
    }));

    assert.equal(crm.calls.created.length, 1);
    assert.equal(crm.calls.created[0].full_name, '+919876543210',
      'the number stands in for the name the CRM requires');
    assert.equal(crm.calls.created[0].phone, '+919876543210');
    assert.equal(repo.leads.held().length, 0);
    assert.match(wa.sent[0].text, /Lead created/);
  });

  test('a name arriving later replaces the placeholder', async () => {
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const msg = incoming({ text: 'New lead @919812345678\n9876543210' });
    await o.handle(msg);

    await o.handle(incoming({
      text: 'Name: Priya Sharma', mentions: [], quotedId: msg.id
    }));

    assert.deepEqual(crm.calls.updated.at(-1).fields, { full_name: 'Priya Sharma' });
  });
});

describe('duplicates (Q5)', () => {
  test('keeps the existing owner and records the message as a remark', async () => {
    makeGroup();
    const crm = fakeCrm({
      createThrows: new DuplicateLeadError({
        detail: 'A lead with phone +919876543210 already exists (Priya S).',
        error_code: 'duplicate_lead',
        existing_lead_id: 'existing-crm-id',
        existing_lead_name: 'Priya S'
      })
    });
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    // Reassigning someone else's lead silently would cause arguments.
    assert.equal(crm.calls.updated.length, 0, 'must not change assignment');
    assert.equal(crm.calls.remarks[0].id, 'existing-crm-id');
    assert.match(wa.sent[0].text, /Already in the CRM/);
    assert.equal(repo.leads.recent()[0].status, 'existing');
  });

  test('a duplicate on a FINISHED lead is held, not silently appended', async () => {
    // On a large lead base "lost" is common. A remark on a closed record is buried,
    // so a genuinely revived enquiry would vanish. Ask a human instead.
    makeGroup();
    const crm = fakeCrm({
      existingStage: 'lost',
      existingName: 'Priya S',
      createThrows: new DuplicateLeadError({
        detail: 'exists', error_code: 'duplicate_lead',
        existing_lead_id: 'closed-lead', existing_lead_name: 'Priya S'
      })
    });
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    assert.equal(crm.calls.remarks.length, 0, 'must not append to a closed lead');
    assert.equal(repo.leads.held()[0].held_reason, 'revived_lost');
    assert.match(wa.sent[0].text, /closed lead/);
  });

  test('remarks carry the WhatsApp message id so a retry duplicate is traceable', async () => {
    // POST /remarks is not idempotent — a retry after a timeout appends a second
    // copy. The stamp makes that identifiable rather than mysterious.
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming({
      text: 'New lead @919812345678\nPriya Sharma\n9876543210\nvery keen'
    }));

    assert.ok(crm.calls.remarks[0].sourceId, 'remark must be stamped with its source');
  });
});

describe('replies that update a lead', () => {
  async function createParent(o) {
    const msg = incoming();
    await o.handle(msg);
    return msg.id;
  }

  test('a labelled reply sets the field and confirms it', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parentId = await createParent(o);

    await o.handle(incoming({
      text: 'University: Delhi University', mentions: [], quotedId: parentId
    }));

    assert.deepEqual(crm.calls.updated.at(-1).fields, { university: 'Delhi University' });
    assert.match(wa.sent.at(-1).text, /University → Delhi University/);
  });

  test('plain text becomes a remark, never a field', async () => {
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const parentId = await createParent(o);

    await o.handle(incoming({
      text: 'she is very keen, needs 15 lakh', mentions: [], quotedId: parentId
    }));

    // Nothing infers that "15 lakh" means loan_amount — a wrong guess corrupts a
    // record silently.
    assert.equal(crm.calls.updated.length, 0);
    assert.match(crm.calls.remarks.at(-1).text, /very keen/);
  });

  test('an acknowledgement reaches nothing but is still recorded (R11.1)', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parentId = await createParent(o);

    const before = crm.calls.remarks.length;
    await o.handle(incoming({ text: 'ok', mentions: [], quotedId: parentId }));

    assert.equal(crm.calls.remarks.length, before, 'must not reach the CRM');
    assert.equal(wa.sent.length, 1, 'must not reply');
    assert.ok(repo.skipped.recent().some((s) => s.reason === 'noise_acknowledgement'),
      'but must be kept so the noise list can be corrected');
  });

  test('an unknown label is explained and saved as a note', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parentId = await createParent(o);

    await o.handle(incoming({
      text: 'Budget Range: 20L', mentions: [], quotedId: parentId
    }));

    assert.match(crm.calls.remarks.at(-1).text, /Budget Range: 20L/);
    assert.match(wa.sent.at(-1).text, /isn't a field I know/);
  });

  test('a reply to something that is not a lead is treated as a new message', async () => {
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming({
      text: 'good morning', mentions: [], quotedId: 'UNKNOWN-MSG'
    }));

    assert.equal(crm.calls.created.length, 0);
    assert.equal(crm.calls.remarks.length, 0);
  });
});

describe('group and sending guards', () => {
  test('an inactive group is ignored entirely', async () => {
    makeGroup({ active: false });
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming());
    assert.equal(crm.calls.created.length, 0);
  });

  test('a bank group never creates a lead', async () => {
    // Bank groups follow an entirely different set of rules — see bank.test.js.
    makeGroup({ purpose: 'bank' });
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    assert.equal(crm.calls.created.length, 0, 'leads are never created from a bank group');
    assert.equal(wa.sent.length, 0, 'and the bot never posts there');
  });

  test('sending off still captures the lead (S3/S4)', async () => {
    makeGroup({ send: false });
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    // A send problem must never cost a lead.
    assert.equal(crm.calls.created.length, 1);
    assert.equal(wa.sent.length, 0);
  });

  test('the kill switch silences replies but not capture (S4)', async () => {
    makeGroup();
    repo.settings.set('sending_paused', 'true');
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    assert.equal(crm.calls.created.length, 1);
    assert.equal(wa.sent.length, 0);
  });
});

describe('CRM failures', () => {
  test('a failure leaves the lead pending for retry and warns once (S6)', async () => {
    makeGroup();
    const crm = fakeCrm({ createThrows: new Error('ECONNRESET') });
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    const stored = repo.leads.recent()[0];
    assert.equal(stored.status, 'pending', 'must stay retryable, never be dropped');
    assert.equal(stored.attempts, 1);
    assert.match(wa.sent[0].text, /Couldn't save this to the CRM/);
  });

  test('the lead survives in our database even when the CRM never answers', async () => {
    makeGroup();
    const crm = fakeCrm({ createThrows: new Error('down') });
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming());

    const stored = repo.leads.recent()[0];
    assert.equal(stored.name, 'Priya Sharma');
    assert.equal(stored.phone, '+919876543210');
    assert.equal(stored.raw_message.includes('Priya Sharma'), true);
  });
});

describe('duplicate reply shows where the lead stands', () => {
  test('reports stage, counsellor and detail from the existing lead', async () => {
    // The point is that nobody should have to open the CRM to find out whether a
    // lead is already being worked, and by whom.
    makeGroup();
    const crm = fakeCrm({
      existingStage: 'processing',
      createThrows: new DuplicateLeadError({
        detail: 'exists', error_code: 'duplicate_lead',
        existing_lead_id: 'existing-id', existing_lead_name: 'Jaanvi Dixit'
      })
    });
    crm.getLead = async () => ({
      id: 'existing-id', serial_no: 8871, full_name: 'Jaanvi Dixit',
      current_stage: 'processing', assigned_agent_id: 'agent-1',
      university: 'GLA University', loan_amount: '7 Lakh',
      created_at: '2026-03-12T10:00:00Z'
    });
    crm.users = new Map([['agent-1', { id: 'agent-1', full_name: 'Rudra Taneja' }]]);

    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    const text = wa.sent[0].text;
    assert.match(text, /#8871/, 'serial so it can be found');
    assert.match(text, /Stage: Processing/);
    assert.match(text, /Counsellor: Rudra Taneja/, 'resolved from the cached user list');
    assert.match(text, /University: GLA University/);
    assert.match(text, /Loan: 7 Lakh/);
  });

  test('empty fields are left out rather than shown blank', async () => {
    makeGroup();
    const crm = fakeCrm({
      createThrows: new DuplicateLeadError({
        detail: 'exists', error_code: 'duplicate_lead', existing_lead_id: 'e1'
      })
    });
    crm.getLead = async () => ({
      id: 'e1', serial_no: 12, full_name: 'Someone',
      current_stage: 'created', university: null, loan_amount: null
    });
    crm.users = new Map();

    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming());

    assert.doesNotMatch(wa.sent[0].text, /University:/);
    assert.doesNotMatch(wa.sent[0].text, /Loan:/);
    assert.match(wa.sent[0].text, /Stage: Created/);
  });
});

describe('gap recovery', () => {
  test('a watermark is recorded for every message, lead or not', async () => {
    // This is the point the phone is asked to replay from after a gap. It must be
    // set even for messages that are not leads, or a gap after a run of chatter
    // would replay from far too far back.
    makeGroup();
    const o = new Orchestrator({ crm: fakeCrm(), whatsapp: fakeWhatsApp() });

    await o.handle(incoming({ id: 'MSG-CHAT', text: 'good morning', mentions: [] }));

    const g = repo.groups.byWaId('120363999@g.us');
    assert.equal(g.last_message_id, 'MSG-CHAT');
    assert.ok(g.last_message_ts, 'timestamp must be stored for the replay request');
  });

  test('the watermark never moves backwards', async () => {
    // Replayed messages arrive out of order and are older than what we already
    // have; letting them rewind the watermark would replay the same window
    // forever.
    makeGroup();
    const o = new Orchestrator({ crm: fakeCrm(), whatsapp: fakeWhatsApp() });

    await o.handle(incoming({ id: 'NEW', text: 'hi', mentions: [], timestamp: 2000 }));
    await o.handle(incoming({ id: 'OLD', text: 'hi', mentions: [], timestamp: 1000 }));

    assert.equal(repo.groups.byWaId('120363999@g.us').last_message_id, 'NEW');
  });

  test('replaying a message already handled creates nothing', async () => {
    // What makes aggressive re-fetching safe.
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const msg = incoming();

    await o.handle(msg);
    await o.handle(msg);   // as if replayed from history

    assert.equal(crm.calls.created.length, 1);
  });
});

describe('a reply fills fields the same way a first message does', () => {
  async function withParent(o) {
    const msg = incoming();
    await o.handle(msg);
    return msg.id;
  }

  test('an unlabelled reply sets university and loan, not just notes', async () => {
    // Seen live: replying "10 Lacs / Bharath University Chennai" to a lead put
    // both into notes, while the identical text in a FIRST message filled the
    // fields. Same words, two different outcomes.
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const parentId = await withParent(o);

    await o.handle(incoming({
      text: '10 Lacs\n\nBharath University Chennai',
      mentions: [], quotedId: parentId
    }));

    assert.deepEqual(crm.calls.updated.at(-1).fields, {
      loan_amount: '10 Lakh',
      university: 'Bharath University Chennai'
    });
  });

  test('text claimed by a field is not repeated in the notes', async () => {
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const parentId = await withParent(o);
    const before = crm.calls.remarks.length;

    await o.handle(incoming({
      text: '10 Lacs\nBharath University Chennai',
      mentions: [], quotedId: parentId
    }));

    assert.equal(crm.calls.remarks.length, before, 'nothing left over to note');
  });

  test('a reply the bot cannot place still becomes a note', async () => {
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const parentId = await withParent(o);

    await o.handle(incoming({
      text: 'he will call back after 6', mentions: [], quotedId: parentId
    }));

    assert.match(crm.calls.remarks.at(-1).text, /call back after 6/);
  });
});

describe('replacing a value that is already there', () => {
  async function withParent(o) {
    const msg = incoming();
    await o.handle(msg);
    return msg.id;
  }

  test('an empty field is simply set', async () => {
    makeGroup();
    const crm = fakeCrm({ currentFields: { university: null } });
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parentId = await withParent(o);

    await o.handle(incoming({
      text: 'Bharath University Chennai', mentions: [], quotedId: parentId
    }));

    assert.match(wa.sent.at(-1).text, /✅ University → Bharath University Chennai/);
  });

  test('replacing a value is announced, not done silently', async () => {
    // Overwriting a counsellor's entry without saying so is how people stop
    // trusting the bot.
    makeGroup();
    const crm = fakeCrm({ currentFields: { university: 'GLA Mathura' } });
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parentId = await withParent(o);

    await o.handle(incoming({
      text: 'Bharath University Chennai', mentions: [], quotedId: parentId
    }));

    assert.match(wa.sent.at(-1).text, /GLA Mathura → Bharath University Chennai/);
  });

  test('the replaced value is kept as a note', async () => {
    // A correction must never destroy what was there.
    makeGroup();
    const crm = fakeCrm({ currentFields: { university: 'GLA Mathura' } });
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const parentId = await withParent(o);

    await o.handle(incoming({
      text: 'Bharath University Chennai', mentions: [], quotedId: parentId
    }));

    assert.match(crm.calls.remarks.at(-1).text,
      /university changed from "GLA Mathura" to "Bharath University Chennai"/);
  });

  test('writing the same value again does nothing at all', async () => {
    makeGroup();
    const crm = fakeCrm({ currentFields: { university: 'GLA Mathura' } });
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parentId = await withParent(o);
    const before = crm.calls.updated.length;

    await o.handle(incoming({
      text: 'GLA Mathura', mentions: [], quotedId: parentId
    }));

    assert.equal(crm.calls.updated.length, before, 'no pointless write');
    assert.equal(wa.sent.length, 1, 'and no pointless reply');
  });
});

describe('commands', () => {
  test('"my leads" answers the person who asked', async () => {
    makeGroup();
    const crm = fakeCrm();
    crm.listLeads = async (f) => (f.current_stage === 'created'
      ? [{ phone: '+919876543210', full_name: 'Kiran',
           current_stage: 'created', assigned_agent_id: RAHUL_CRM }]
      : []);
    crm.users = new Map([[RAHUL_CRM, { id: RAHUL_CRM, full_name: 'Rahul Kumar' }]]);

    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming({
      text: 'my leads', mentions: [], senderPhone: RAHUL_WA
    }));

    assert.match(wa.sent[0].text, /Rahul Kumar — 1 open lead/);
    assert.match(wa.sent[0].text, /Kiran/);
    assert.equal(crm.calls.created.length, 0, 'a command must never create a lead');
  });

  test('someone not in the employee list is ignored, not answered', async () => {
    // They have no leads to show, and explaining that to every non-counsellor in
    // the group would just be noise.
    makeGroup();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm: fakeCrm(), whatsapp: wa }).handle(incoming({
      text: 'my leads', mentions: [], senderPhone: '+919999999999'
    }));

    assert.equal(wa.sent.length, 0, 'the bot must stay quiet');
  });

  test('a command is never mistaken for a lead', async () => {
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming({
      text: 'help', mentions: [], senderPhone: RAHUL_WA
    }));
    assert.equal(crm.calls.created.length, 0);
  });

  test('conversation that merely contains a command word is left alone', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming({
      text: 'let me check my leads later', mentions: [], senderPhone: RAHUL_WA
    }));

    assert.equal(wa.sent.length, 0, 'the bot must stay quiet');
  });
});

describe('reassignment', () => {
  const ZAID_WA = '+919999888877';
  const ZAID_CRM = 'crm-profile-zaid';

  async function setup(overrides = {}) {
    makeGroup();
    repo.employees.upsert({
      waPhone: ZAID_WA, crmProfileId: ZAID_CRM, name: 'Zaid Ansari'
    });
    const crm = fakeCrm(overrides);
    crm.users = new Map([
      [RAHUL_CRM, { id: RAHUL_CRM, full_name: 'Rahul Kumar' }],
      [ZAID_CRM, { id: ZAID_CRM, full_name: 'Zaid Ansari' }]
    ]);
    crm.getLead = async (id) => ({
      id,
      full_name: 'Kiran',
      current_stage: overrides.stage || 'processing',
      assigned_agent_id: overrides.owner === undefined ? RAHUL_CRM : overrides.owner
    });
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const msg = incoming();
    await o.handle(msg);
    return { o, crm, wa, parentId: msg.id };
  }

  test('moves the lead and names both sides', async () => {
    // Someone losing a lead they were working must see it happen, in the group.
    const { o, crm, wa, parentId } = await setup();

    await o.handle(incoming({
      text: 'assign @919999888877', mentions: [ZAID_WA], quotedId: parentId,
      senderPhone: '+917827225354'
    }));

    assert.deepEqual(crm.calls.updated.at(-1).fields, { assigned_agent_id: ZAID_CRM });
    assert.match(wa.sent.at(-1).text, /Lead moved/);
    assert.match(wa.sent.at(-1).text, /Rahul Kumar → @919999888877/);
  });

  test('records the move in the CRM', async () => {
    const { o, crm, parentId } = await setup();

    await o.handle(incoming({
      text: 'transfer @919999888877', mentions: [ZAID_WA], quotedId: parentId,
      senderPhone: '+917827225354'
    }));

    assert.match(crm.calls.remarks.at(-1).text,
      /Reassigned from Rahul Kumar to Zaid Ansari/);
  });

  test('a bare tag does NOT move anything', async () => {
    // People tag each other constantly. Without the explicit word this would be
    // a silent handover every time someone was mentioned in a reply.
    const { o, crm, parentId } = await setup();
    const before = crm.calls.updated.length;

    await o.handle(incoming({
      text: '@919999888877', mentions: [ZAID_WA], quotedId: parentId
    }));

    assert.equal(crm.calls.updated.length, before, 'must not reassign');
  });

  test('a closed lead is refused, not moved sideways', async () => {
    const { o, crm, wa, parentId } = await setup({ stage: 'disbursed' });
    const before = crm.calls.updated.length;

    await o.handle(incoming({
      text: 'assign @919999888877', mentions: [ZAID_WA], quotedId: parentId,
      senderPhone: '+917827225354'
    }));

    assert.equal(crm.calls.updated.length, before);
    assert.match(wa.sent.at(-1).text, /Disbursed/);
  });

  test('an unmapped person is refused', async () => {
    const { o, crm, wa, parentId } = await setup();
    const before = crm.calls.updated.length;

    await o.handle(incoming({
      text: 'assign @919111111111', mentions: ['+919111111111'], quotedId: parentId,
      senderPhone: '+917827225354'
    }));

    assert.equal(crm.calls.updated.length, before);
    assert.match(wa.sent.at(-1).text, /employee list/);
  });

  test('moving it to whoever already has it does nothing', async () => {
    const { o, crm, wa, parentId } = await setup({ owner: ZAID_CRM });
    const before = crm.calls.updated.length;

    await o.handle(incoming({
      text: 'assign @919999888877', mentions: [ZAID_WA], quotedId: parentId,
      senderPhone: '+917827225354'
    }));

    assert.equal(crm.calls.updated.length, before);
    assert.match(wa.sent.at(-1).text, /already theirs/);
  });

  test('tagging two people is refused rather than guessed', async () => {
    const { o, crm, wa, parentId } = await setup();
    const before = crm.calls.updated.length;

    await o.handle(incoming({
      text: 'assign @a @b', mentions: [ZAID_WA, RAHUL_WA], quotedId: parentId,
      senderPhone: '+917827225354'
    }));

    assert.equal(crm.calls.updated.length, before);
    assert.match(wa.sent.at(-1).text, /only one person/);
  });

  test('an ordinary sentence opening with "move" is not an instruction', async () => {
    const { o, crm, parentId } = await setup();
    const before = crm.calls.updated.length;

    await o.handle(incoming({
      text: 'move to Canada next year is what he wants for his masters',
      mentions: [ZAID_WA], quotedId: parentId
    }));

    assert.equal(crm.calls.updated.length, before);
  });
});

describe('only permitted people can move a lead', () => {
  test('someone else is refused, and nothing moves', async () => {
    // Reassignment takes work off whoever had it. Restricted to named numbers,
    // not to everyone in the employee map.
    makeGroup();
    repo.employees.upsert({
      waPhone: '+919999888877', crmProfileId: 'crm-zaid', name: 'Zaid Ansari'
    });
    const crm = fakeCrm();
    crm.getLead = async (id) => ({ id, full_name: 'Kiran',
      current_stage: 'processing', assigned_agent_id: RAHUL_CRM });
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const msg = incoming();
    await o.handle(msg);
    const before = crm.calls.updated.length;

    await o.handle(incoming({
      text: 'assign @919999888877', mentions: ['+919999888877'], quotedId: msg.id,
      senderPhone: '+919311359236'      // Himanshu — an employee, but not permitted
    }));

    assert.equal(crm.calls.updated.length, before, 'nothing may move');
    assert.match(wa.sent.at(-1).text, /Only an admin can move a lead/);
  });
});

describe('one message in, one message out', () => {
  test('a reply listing several things gets a single reply', async () => {
    // Seen in a real message: a university, tuition, living expenses and a total
    // produced four separate bot messages. A bot that answers four times to one
    // message is one people mute.
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parent = incoming();
    await o.handle(parent);
    const before = wa.sent.length;

    await o.handle(incoming({
      text: 'Northeastern University Boston\nTution - 52 Lakhs\n'
        + 'living expenses - 60 lakhs\n\nTotal : 1.1 Cr',
      mentions: [], quotedId: parent.id
    }));

    assert.equal(wa.sent.length - before, 1, 'exactly one reply');
    assert.match(wa.sent.at(-1).text, /University → Northeastern University Boston/);
    assert.match(wa.sent.at(-1).text, /Tution/, 'and it still says what it could not use');
  });
});

describe('a breakdown with a total (real message)', () => {
  test('takes the total, keeps the components as notes, replies once', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parent = incoming();
    await o.handle(parent);
    const before = wa.sent.length;

    await o.handle(incoming({
      text: 'Northeastern University Boston\nTution - 52 Lakhs\n'
        + 'living expenses - 60 lakhs\n\nTotal : 1.1 Cr',
      mentions: [], quotedId: parent.id
    }));

    const written = crm.calls.updated.at(-1).fields;
    assert.equal(written.loan_amount, '1.1 Cr', 'the total, not the first figure');
    assert.equal(written.university, 'Northeastern University Boston');
    assert.equal(wa.sent.length - before, 1, 'one reply');
  });

  test('with no total it asks rather than guessing', async () => {
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const o = new Orchestrator({ crm, whatsapp: wa });
    const parent = incoming();
    await o.handle(parent);

    await o.handle(incoming({
      text: 'Tution - 52 Lakhs\nliving expenses - 60 lakhs',
      mentions: [], quotedId: parent.id
    }));

    assert.match(wa.sent.at(-1).text, /Which is the loan amount\? 52 Lakh · 60 Lakh/);
    const written = crm.calls.updated.at(-1)?.fields || {};
    assert.equal(written.loan_amount, undefined, 'nothing guessed');
  });
});

describe('several leads in one message', () => {
  const batch = (over = {}) => incoming({
    text: 'New leads @919812345678\n\nPriya Sharma 9876543210\n'
      + 'Rahul Verma 9812345670\nAnjali Mehta 9998887776',
    ...over
  });

  test('creates every lead, not just the first', async () => {
    // Before this, two of three were silently dropped into a note.
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(batch());

    assert.equal(crm.calls.created.length, 3);
    assert.deepEqual(crm.calls.created.map((c) => c.full_name),
      ['Priya Sharma', 'Rahul Verma', 'Anjali Mehta']);
  });

  test('all assigned to the one tagged person', async () => {
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(batch());

    for (const c of crm.calls.created) assert.equal(c.assigned_agent_id, RAHUL_CRM);
  });

  test('one reply for the batch, not one per lead', async () => {
    makeGroup();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm: fakeCrm(), whatsapp: wa }).handle(batch());

    assert.equal(wa.sent.length, 1);
    assert.match(wa.sent[0].text, /3 of 3 leads created/);
  });

  test('a duplicate in the batch does not stop the others', async () => {
    // With twenty leads, some are always already in the CRM.
    makeGroup();
    let n = 0;
    const crm = fakeCrm();
    const realCreate = crm.createLead;
    crm.createLead = async (fields) => {
      n += 1;
      if (n === 2) {
        throw new DuplicateLeadError({
          detail: 'exists', error_code: 'duplicate_lead',
          existing_lead_id: 'dup-1', existing_lead_name: 'Rahul Verma'
        });
      }
      return realCreate(fields);
    };
    crm.getLead = async () => ({ id: 'dup-1', current_stage: 'processing',
      full_name: 'Rahul Verma', assigned_agent_id: RAHUL_CRM });
    crm.users = new Map([[RAHUL_CRM, { id: RAHUL_CRM, full_name: 'Rahul Kumar' }]]);

    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(batch());

    assert.match(wa.sent[0].text, /2 of 3 leads created/);
    assert.match(wa.sent[0].text, /1 already in the CRM/);
    assert.match(wa.sent[0].text, /Rahul Verma/);
  });

  test('a redelivered batch creates nothing twice', async () => {
    makeGroup();
    const crm = fakeCrm();
    const o = new Orchestrator({ crm, whatsapp: fakeWhatsApp() });
    const msg = batch();

    await o.handle(msg);
    await o.handle(msg);

    assert.equal(crm.calls.created.length, 3);
  });

  test('an untagged batch is held once, not three times', async () => {
    // No "@919812345678" in the body: WhatsApp only renders that when a real
    // mention exists, and a stray number with no name is not a lead line.
    makeGroup();
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    await new Orchestrator({ crm, whatsapp: wa }).handle(incoming({
      text: 'New leads\n\nPriya Sharma 9876543210\n'
        + 'Rahul Verma 9812345670\nAnjali Mehta 9998887776',
      mentions: []
    }));

    assert.equal(crm.calls.created.length, 0);
    assert.equal(wa.sent.length, 1, 'one message about the whole batch');
    assert.equal(repo.leads.held().length, 3, 'but every lead is kept');
  });

  test('one lead with an alternate number is NOT split', async () => {
    // The dangerous case: a phantom lead on the borrower's second number.
    makeGroup();
    const crm = fakeCrm();
    await new Orchestrator({ crm, whatsapp: fakeWhatsApp() }).handle(incoming({
      text: 'Priya Sharma\n9876543210\nalt 9812345670'
    }));

    assert.equal(crm.calls.created.length, 1);
    assert.equal(crm.calls.created[0].phone, '+919876543210');
  });
});

describe('a number the bot cannot read', () => {
  test('an overseas lead is created, not dropped', async () => {
    // 2 Sep 2026: this exact message was posted twice and silently skipped both
    // times, because only Indian numbers were recognised.
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const group = makeGroup();
    repo.employees.upsert({
      waPhone: RAHUL_WA, crmProfileId: RAHUL_CRM, name: 'Zaid', email: 'z@x.com'
    });

    const o = new Orchestrator({ crm, whatsapp: wa });
    await o.handle(incoming({
      text: 'Ajaj Shaikh\n+96569950748\najazammyu@gmail.com\n\n@919812345678'
    }), {});

    assert.equal(crm.calls.created.length, 1, 'the lead should reach the CRM');
    assert.equal(crm.calls.created[0].phone, '+96569950748');
    assert.equal(crm.calls.created[0].full_name, 'Ajaj Shaikh');
    assert.match(wa.sent[0].text, /Lead created/);
  });

  test('a number it still cannot read gets a reply, not silence', async () => {
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const group = makeGroup();
    repo.employees.upsert({
      waPhone: RAHUL_WA, crmProfileId: RAHUL_CRM, name: 'Zaid', email: 'z@x.com'
    });

    const o = new Orchestrator({ crm, whatsapp: wa });
    const msg = incoming({ text: 'Ajaj Shaikh\n0096569950748\n@919812345678' });
    await o.handle(msg, {});

    assert.equal(crm.calls.created.length, 0, 'nothing should reach the CRM');
    assert.equal(wa.sent.length, 1, 'the group must be told');
    assert.match(wa.sent[0].text, /couldn't read that number/);
    assert.match(wa.sent[0].text, /country code/);

    // Recorded with its own reason, so the panel shows it rather than burying it
    // among ordinary non-leads.
    const rows = repo.skipped.recent(10);
    assert.equal(rows[0].reason, 'unreadable_number');

    // S2 — a redelivered message must not produce a second reply.
    await o.handle(msg, {});
    assert.equal(wa.sent.length, 1, 'redelivery must not reply twice');
  });

  test('ordinary tagged chatter is still answered with silence', async () => {
    // The 40 other no_phone skips in live data look like this. Replying to them
    // would make the bot an interruption in a group people work in.
    const crm = fakeCrm();
    const wa = fakeWhatsApp();
    const group = makeGroup();

    const o = new Orchestrator({ crm, whatsapp: wa });
    for (const text of [
      '@919812345678 apne apne cases update kro',
      'updated in sheet @919812345678 sir',
      'All leads status updates, except Himanshu.\n@919812345678 sir FYI'
    ]) {
      await o.handle(incoming({ text }), {});
    }

    assert.equal(wa.sent.length, 0, 'chatter must never draw a reply');
    assert.equal(crm.calls.created.length, 0);
  });
});
