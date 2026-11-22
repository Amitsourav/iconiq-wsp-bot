/**
 * A conversation run by Meta's Business AI, with the bot paused, reaching the
 * CRM: enquiry type, partner type, and the AI's guess when nothing is clear.
 */
const { test, describe, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-meta-ai-crm.db');
process.env.DB_PATH = TEST_DB;

const openrouter = require('../src/ai/openrouter');
const db = require('../src/db');
const repo = require('../src/db/repositories');
const { config } = require('../src/config');
const { normalise } = require('../src/whatsapp/messages');
const { Orchestrator } = require('../src/pipeline/orchestrator');

const CHAT = '919800000055@s.whatsapp.net'; // made up

const META_MENU = 'Thanks for reaching out. We manufacture Lithium Batteries & IP66 Hybrid Inverters.\n'
  + 'How can I help you today? Please reply with 1 or 2:\n'
  + '1. I want to become a Dealer / Channel Partner for Hybrid Solutions\n2. I want to place an Order';
const META_PARTNER = 'That\'s great! To get started with our dealer program, please share these details:\n'
  + '1. Your Name\n2. City\n3. Company Name\n4. Are you an EPC partner or a Distributor?\n'
  + '5. Which brands do you work with currently?';
const META_ORDER = 'Glad you\'re ready to place an order! Please share these details:\n'
  + '1. Name\n2. City\n3. Load Capacity (in kW)\n4. Backup required (in Hrs)';

function fakeCrm() {
  const calls = { update: [], remark: [] };
  return {
    calls,
    configured: true,
    async findByPhone() { return { status: 'none', lead: null }; },
    async createLead() { return { lead: { id: 'lead-1' }, deferred: {}, dropped: [] }; },
    async updateLead(id, fields) { calls.update.push(fields); return {}; },
    async addRemark(id, text) { calls.remark.push(text); return {}; },
    async addLeadMessage() { return {}; }
  };
}

async function run(t, lines, { modelSays = null } = {}) {
  db.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
  db.init();
  const before = { ...config.ai };
  Object.assign(config.ai, { enabled: true, extractFields: true, dmMode: 'script', replyDelayMs: 0, replyGapMs: 0 });
  repo.settings.set('sending_paused', 'true');
  mock.method(openrouter, 'chat', async () => (modelSays ? JSON.stringify(modelSays) : '{}'));
  t.after(() => {
    Object.assign(config.ai, before);
    mock.restoreAll(); db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + s, { force: true });
  });

  const crm = fakeCrm();
  const sends = [];
  const o = new Orchestrator({ crm, whatsapp: { async reply({ text }) { sends.push(text); return true; } } });
  for (const [i, [who, text]] of lines.entries()) {
    const raw = { key: { id: `x${i}`, remoteJid: CHAT, fromMe: who === 'meta' }, message: { conversation: text }, messageTimestamp: 1 };
    if (who === 'meta') await o.handleOwnDirect(normalise(raw), raw);
    else await o.handleDirect(normalise(raw), raw);
    await o.settled();
  }
  return { crm, sends };
}

describe('a Meta AI conversation reaching the CRM', () => {
  test('dealer: B2B, partner type, and the bot says nothing', async (t) => {
    const { crm, sends } = await run(t, [
      ['customer', 'hi, can I get more info on this'],
      ['meta', META_MENU],
      ['customer', 'dealer'],
      ['meta', META_PARTNER],
      ['customer', 'Rajesh\nNoida\nSun Power Pvt Ltd\nDistributor\nLuminous']
    ]);

    assert.deepStrictEqual(sends, []);
    assert.ok(crm.calls.update.some((f) => f.enquiry_type === 'channel_partner'));
    assert.ok(crm.calls.remark.includes('Enquiry type: Channel Partner (Dealer / Distributor)'));
    assert.ok(crm.calls.remark.includes('Partner type: Distributor'));
    // The CRM field waits until the CRM has it.
    assert.ok(!crm.calls.update.some((f) => 'partner_type' in f));
    assert.strictEqual(crm.calls.remark.filter((r) => r.startsWith('Enquiry type')).length, 1, 'said once');
  });

  test('order: B2C', async (t) => {
    const { crm } = await run(t, [
      ['customer', 'Hello! Can I get more info on this?'],
      ['meta', META_MENU],
      ['customer', 'order'],
      ['meta', META_ORDER],
      ['customer', 'Amit, Pune, 5 kW, 4 hours']
    ]);
    assert.ok(crm.calls.update.some((f) => f.enquiry_type === 'personal_order'));
    assert.ok(!crm.calls.remark.some((r) => r.startsWith('Partner type')));
  });

  test('partner type goes to the CRM field once it is switched on', async (t) => {
    config.crm.partnerTypeField = true;
    t.after(() => { config.crm.partnerTypeField = false; });
    const { crm } = await run(t, [
      ['customer', 'hi'], ['meta', META_MENU], ['customer', '1'], ['meta', META_PARTNER],
      ['customer', 'We are an EPC company in Jaipur']
    ]);
    assert.ok(crm.calls.update.some((f) => f.partner_type === 'epc'));
  });

  test('nothing clear: the AI guess is set, and marked as a guess', async (t) => {
    const { crm } = await run(t, [
      ['customer', 'hi I run a solar installation business'],
      ['customer', 'we want to sell your inverters in our area']
    ], { modelSays: { enquiry_guess: 'channel_partner', enquiry_reason: 'They said "we want to sell your inverters".' } });

    assert.ok(crm.calls.update.some((f) => f.enquiry_type === 'channel_partner'));
    assert.ok(crm.calls.remark.some((r) => r.startsWith('Enquiry type (AI-identified, please check): Channel Partner')
      && r.includes('sell your inverters')));
  });

  test('no guess from a single hello', async (t) => {
    const { crm } = await run(t, [['customer', 'hi']],
      { modelSays: { enquiry_guess: 'personal_order', enquiry_reason: '?' } });
    assert.ok(!crm.calls.update.some((f) => 'enquiry_type' in f));
  });

  test('a clear answer later corrects a wrong guess', async (t) => {
    const { crm } = await run(t, [
      ['customer', 'hi I need inverters'],
      ['customer', 'for many sites'],
      ['meta', META_MENU],
      ['customer', 'order'],
      ['meta', META_ORDER]
    ], { modelSays: { enquiry_guess: 'channel_partner', enquiry_reason: 'many sites' } });

    const types = crm.calls.update.filter((f) => 'enquiry_type' in f).map((f) => f.enquiry_type);
    assert.deepStrictEqual(types, ['channel_partner', 'personal_order']);
    assert.ok(crm.calls.remark.some((r) => r.startsWith('Enquiry type corrected: Order for Personal / Commercial Use')));
  });
});
