const { test, describe } = require('node:test');
const assert = require('node:assert');

const { classify, fromBusinessMessage, fromMenuReply, isMenu, partnerType } = require('../src/pipeline/enquiryType');

// Meta's Business AI, word for word from the "Test your AI" screen, 22 Nov 2026.
const META_MENU = 'Thanks for reaching out. We manufacture Lithium Batteries & IP66 Hybrid Inverters.\n'
  + 'How can I help you today? Please reply with 1 or 2:\n'
  + '1. I want to become a Dealer / Channel Partner for Hybrid Solutions\n'
  + '2. I want to place an Order';
const META_PARTNER_DETAILS = 'That\'s great! To get started with our dealer program, please share these details:\n'
  + '1. Your Name\n2. City\n3. Company Name\n4. Are you an EPC partner or a Distributor?\n'
  + '5. Which brands do you work with currently?\n'
  + 'Once you share these, our team will get in touch.';
const META_ORDER_DETAILS = 'Glad you\'re ready to place an order! To help you with the right solution, '
  + 'please share these details:\n1. Name\n2. City\n3. Load Capacity (in kW)\n4. Backup required (in Hrs)';

const chat = (...lines) => lines.map(([direction, body]) => ({ direction, body, author: direction === 'out' ? 'business' : null }));

describe('B2B or B2C, from a Meta AI conversation', () => {
  test('the dealer chat from the screenshot is B2B', () => {
    const rows = chat(['in', 'hi, can I get more info on this'], ['out', META_MENU],
      ['in', 'dealer'], ['out', META_PARTNER_DETAILS]);
    assert.deepStrictEqual(classify(rows), { option: 1, source: 'business' });
  });

  test('the order chat from the screenshot is B2C', () => {
    const rows = chat(['in', 'Hello! Can I get more info on this?'], ['out', META_MENU],
      ['in', 'order'], ['out', META_ORDER_DETAILS]);
    assert.deepStrictEqual(classify(rows), { option: 2, source: 'business' });
  });

  test('the menu alone says nothing — it offers both', () => {
    assert.strictEqual(isMenu(META_MENU), true);
    assert.strictEqual(fromBusinessMessage(META_MENU), null);
    assert.strictEqual(classify(chat(['in', 'hi'], ['out', META_MENU])), null);
  });

  test('Meta AI rewording its details request is still recognised', () => {
    assert.strictEqual(fromBusinessMessage('Great! For our partner program, could you share your company name and which brands you deal in?'), 1);
    assert.strictEqual(fromBusinessMessage('Sure. What load capacity (in kW) do you need, and how many hours of backup required?'), 2);
  });

  test('before Meta AI answers, the customer\'s own reply to the menu decides', () => {
    assert.deepStrictEqual(classify(chat(['out', META_MENU], ['in', '1'])), { option: 1, source: 'reply' });
    assert.deepStrictEqual(classify(chat(['out', META_MENU], ['in', 'Order'])), { option: 2, source: 'reply' });
    assert.deepStrictEqual(classify(chat(['out', META_MENU], ['in', 'I am a distributor'])), { option: 1, source: 'reply' });
  });

  test('a reply that only mentions a word is not a choice', () => {
    assert.strictEqual(fromMenuReply('I want 1 inverter for my dealer'), null);
    assert.strictEqual(fromMenuReply('what is the price'), null);
    assert.strictEqual(classify(chat(['out', META_MENU], ['in', 'what is the price of 5kw?'])), null);
  });

  test('a customer word with no menu before it decides nothing', () => {
    assert.strictEqual(classify(chat(['in', 'dealer'])), null);
  });

  test('the bot\'s own script still counts first', () => {
    const rows = chat(['out', 'MENU'], ['in', '2'], ['out', 'OUR ORDER FORM']);
    assert.deepStrictEqual(classify(rows, { scriptDetails: { 1: 'OUR PARTNER FORM', 2: 'OUR ORDER FORM' } }),
      { option: 2, source: 'script' });
  });
});

describe('partner type: EPC, distributor or dealer', () => {
  const asked = ['out', META_PARTNER_DETAILS];

  test('read from the answer to "EPC partner or a Distributor?"', () => {
    assert.strictEqual(partnerType(chat(asked, ['in', 'Rajesh\nNoida\nSun Power Pvt Ltd\nEPC\nLuminous'])), 'epc');
    assert.strictEqual(partnerType(chat(asked, ['in', 'I am a distributor'])), 'distributor');
    assert.strictEqual(partnerType(chat(asked, ['in', 'we are dealers in Agra'])), 'dealer');
  });

  test('two types, or a negated one, is left for a person', () => {
    assert.strictEqual(partnerType(chat(asked, ['in', 'both EPC and distributor'])), null);
    assert.strictEqual(partnerType(chat(asked, ['in', 'not a distributor yet'])), null);
  });

  test('never read before the question was asked', () => {
    assert.strictEqual(partnerType(chat(['in', 'I am a distributor'], asked)), null);
    assert.strictEqual(partnerType(chat(['in', 'I am a distributor'])), null);
  });
});

describe('only Meta AI\'s own messages count', () => {
  test('the bot\'s old details request is not a choice anyone made', () => {
    // Before the menu, the bot asked every customer for load and backup. Read
    // as Meta AI's order form, that made every old lead B2C on the backfill.
    const rows = [
      { direction: 'in', body: 'hi', author: null },
      { direction: 'out', body: 'Please share your load capacity (in kW) and backup required (in Hrs)', author: 'bot' },
      { direction: 'out', body: 'What load capacity in kW do you need?', author: null }
    ];
    assert.strictEqual(classify(rows), null);
  });
});
