const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-bank.db');
process.env.DB_PATH = TEST_DB;

const db = require('../src/db');
const repo = require('../src/db/repositories');
const { BankHandler, classify } = require('../src/pipeline/bank');
const { Orchestrator } = require('../src/pipeline/orchestrator');

const ZAID_WA = '+918796222415';
const ZAID_CRM = 'crm-zaid';

/** A CRM double recording bank calls. */
function fakeCrm({ lead = { id: 'crm-lead-1', full_name: 'Priya Sharma' } } = {}) {
  const calls = { shares: [], messages: [], lookups: [] };
  return {
    calls,
    users: new Map(),
    async findByPhone(phone) {
      calls.lookups.push(phone);
      if (lead === 'ambiguous') return { status: 'ambiguous', lead: null, candidates: 2 };
      if (lead === 'error') throw new Error('CRM unreachable');
      return lead ? { status: 'found', lead } : { status: 'none', lead: null };
    },
    async recordBankShare(leadId, share) { calls.shares.push({ leadId, ...share }); return { id: 's1' }; },
    async addBankMessage(leadId, bank, msg) { calls.messages.push({ leadId, bank, ...msg }); return { id: 'm1' }; }
  };
}

function fakeWhatsApp() {
  const sent = [];
  return { sent, async reply(m) { sent.push(m); return true; } };
}

function bankGroup(bank = 'ICICI') {
  const g = repo.groups.upsert('120363bank@g.us', 'ICICI ED Loan');
  repo.groups.setPurpose(g.id, 'bank');
  repo.groups.setBank(g.id, bank);
  repo.groups.setActive(g.id, true);
  return repo.groups.byWaId('120363bank@g.us');
}

function inhouseGroup() {
  const g = repo.groups.upsert('120363home@g.us', 'FMC In-House');
  repo.groups.setActive(g.id, true);
  repo.groups.setSendEnabled(g.id, true);
  return repo.groups.byWaId('120363home@g.us');
}

const msg = (over = {}) => ({
  id: 'BM-' + Math.random().toString(36).slice(2),
  groupId: '120363bank@g.us',
  groupName: 'ICICI ED Loan',
  isGroup: true,
  fromMe: false,
  senderPhone: ZAID_WA,
  text: '9876543210 Priya Sharma',
  mentions: [],
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
  repo.employees.upsert({ waPhone: ZAID_WA, crmProfileId: ZAID_CRM, name: 'Zaid' });
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('classify a bank-group message', () => {
  test('a phone number means the lead was shared with this bank', () => {
    assert.equal(classify({ text: '9876543210 Priya', mentions: [] }).kind, 'share');
  });

  test('a message with no number is conversation', () => {
    assert.equal(classify({ text: 'login done, docs pending', mentions: [] }).kind, 'chatter');
  });

  test('acknowledgements are ignored entirely', () => {
    // Bank groups are busy. Most of what is said is not about a specific file.
    for (const text of ['ok', 'done', '👍', 'thanks']) {
      assert.equal(classify({ text, mentions: [] }).kind, 'ignore');
    }
  });

  test("a tagged person's number is never the lead's", () => {
    const r = classify({ text: '@919812345678 please check', mentions: ['+919812345678'] });
    assert.equal(r.kind, 'chatter', 'the mention is a human, not a lead');
  });
});

describe('sharing a lead with a bank', () => {
  test('records the share against the right bank and person', async () => {
    const group = bankGroup('ICICI');
    const crm = fakeCrm();
    await new BankHandler({ crm, whatsapp: fakeWhatsApp() }).handle(msg(), group);

    assert.equal(crm.calls.shares.length, 1);
    assert.equal(crm.calls.shares[0].bankName, 'ICICI');
    assert.equal(crm.calls.shares[0].sharedBy, ZAID_CRM);
    assert.equal(crm.calls.shares[0].leadId, 'crm-lead-1');
  });

  test('the sharing message becomes the first line of that conversation', async () => {
    const group = bankGroup();
    const crm = fakeCrm();
    await new BankHandler({ crm, whatsapp: fakeWhatsApp() }).handle(msg(), group);

    assert.equal(crm.calls.messages.length, 1);
    assert.equal(crm.calls.messages[0].bank, 'ICICI');
    assert.equal(crm.calls.messages[0].isOurTeam, true);
  });

  test('the bot never posts in the bank group', async () => {
    const group = bankGroup();
    const wa = fakeWhatsApp();
    await new BankHandler({ crm: fakeCrm(), whatsapp: wa }).handle(msg(), group);

    assert.equal(wa.sent.length, 0);
  });

  test('a redelivered message records nothing twice', async () => {
    const group = bankGroup();
    const crm = fakeCrm();
    const h = new BankHandler({ crm, whatsapp: fakeWhatsApp() });
    const m = msg();

    await h.handle(m, group);
    await h.handle(m, group);

    assert.equal(crm.calls.shares.length, 1);
  });

  test('two numbers in one message record two shares', async () => {
    const group = bankGroup();
    const crm = fakeCrm();
    await new BankHandler({ crm, whatsapp: fakeWhatsApp() })
      .handle(msg({ text: '9876543210 Priya\n9812345670 Rahul' }), group);

    assert.equal(crm.calls.shares.length, 2);
  });
});

describe('a lead the CRM does not have', () => {
  test('tells our own team, in our own group', async () => {
    const group = bankGroup();
    inhouseGroup();
    const crm = fakeCrm({ lead: null });
    const wa = fakeWhatsApp();

    await new BankHandler({ crm, whatsapp: wa }).handle(msg(), group);

    assert.equal(crm.calls.shares.length, 0, 'nothing recorded against the bank');
    assert.equal(wa.sent.length, 1);
    assert.equal(wa.sent[0].groupId, '120363home@g.us', 'posted in OUR group');
    assert.match(wa.sent[0].text, /not in the CRM/);
    assert.match(wa.sent[0].text, /ICICI/);
    assert.match(wa.sent[0].text, /by Zaid/);
  });

  test('the notice never goes to the bank group', async () => {
    const group = bankGroup();
    const wa = fakeWhatsApp();
    // No in-house group configured at all.
    await new BankHandler({ crm: fakeCrm({ lead: null }), whatsapp: wa }).handle(msg(), group);

    assert.equal(wa.sent.length, 0, 'silence beats posting in the bank group');
  });
});

describe('conversation after a share', () => {
  test('a reply is kept against that lead and bank', async () => {
    const group = bankGroup();
    const crm = fakeCrm();
    const h = new BankHandler({ crm, whatsapp: fakeWhatsApp() });
    const first = msg();
    await h.handle(first, group);

    await h.handle(msg({ text: 'login done', quotedId: first.id }), group);

    const last = crm.calls.messages.at(-1);
    assert.equal(last.body, 'login done');
    assert.equal(last.bank, 'ICICI');
    assert.equal(last.leadId, 'crm-lead-1');
  });

  test("the bank's own people are captured too, marked as not ours", async () => {
    const group = bankGroup();
    const crm = fakeCrm();
    const h = new BankHandler({ crm, whatsapp: fakeWhatsApp() });
    const first = msg();
    await h.handle(first, group);

    await h.handle(msg({
      text: 'sanctioned, PF pending', quotedId: first.id, senderPhone: '+919000000009'
    }), group);

    assert.equal(crm.calls.messages.at(-1).isOurTeam, false);
  });

  test('a reply to something we never linked is not forced onto a lead', async () => {
    const group = bankGroup();
    const crm = fakeCrm();
    await new BankHandler({ crm, whatsapp: fakeWhatsApp() })
      .handle(msg({ text: 'any update?', quotedId: 'UNKNOWN' }), group);

    assert.equal(crm.calls.messages.length, 0);
    assert.ok(repo.skipped.recent().some((s) => s.reason === 'bank_chatter'));
  });
});

describe('a group with no bank set', () => {
  test('records nothing rather than guessing from the group name', async () => {
    const g = repo.groups.upsert('120363bank@g.us', 'ICICI ED Loan');
    repo.groups.setPurpose(g.id, 'bank');
    repo.groups.setActive(g.id, true);
    const group = repo.groups.byWaId('120363bank@g.us');

    const crm = fakeCrm();
    await new BankHandler({ crm, whatsapp: fakeWhatsApp() }).handle(msg(), group);

    assert.equal(crm.calls.shares.length, 0);
    assert.ok(repo.skipped.recent().some((s) => s.reason === 'bank_not_mapped'));
  });
});

describe('a lookup that could not be answered', () => {
  test('a CRM failure is never reported as "not in the CRM"', async () => {
    // The bug this replaced: a failed search returned null, which read exactly
    // like "no such lead" — so a slow CRM would have the bot announce that real
    // leads did not exist.
    const group = bankGroup();
    inhouseGroup();
    const crm = fakeCrm({ lead: 'error' });
    const wa = fakeWhatsApp();

    await new BankHandler({ crm, whatsapp: wa }).handle(msg(), group);

    assert.equal(wa.sent.length, 0, 'must not claim the lead is missing');
    const share = repo.bankShares.recent()[0];
    assert.equal(share.status, 'pending', 'left for the retry worker');
  });

  test('two leads with the same number is refused, not guessed', async () => {
    // The CRM allows duplicate phones, and their own report confirmed an edit can
    // create them. Recording against the wrong lead is worse than not recording.
    const group = bankGroup();
    inhouseGroup();
    const crm = fakeCrm({ lead: 'ambiguous' });
    const wa = fakeWhatsApp();

    await new BankHandler({ crm, whatsapp: wa }).handle(msg(), group);

    assert.equal(crm.calls.shares.length, 0);
    assert.equal(wa.sent.length, 0, 'and it is not announced as missing either');
    assert.equal(repo.bankShares.recent()[0].status, 'failed');
  });
});
