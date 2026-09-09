const { test, describe } = require('node:test');
const assert = require('node:assert');
const detect = require('../src/pipeline/detect');

const RAHUL = '+919812345678';
const PRIYA = '+919999888877';

describe('classify — R8: phone AND mention', () => {
  test('a typical lead message', () => {
    const r = detect.classify({
      text: 'New lead @919812345678\nPriya Sharma\n9876543210',
      mentions: [RAHUL]
    });
    assert.equal(r.isLead, true);
    assert.equal(r.phone, '+919876543210');
    assert.equal(r.name, 'Priya Sharma');
    assert.equal(r.reason, null, 'nothing should block it');
  });

  test('chat with neither phone nor mention is not a lead', () => {
    const r = detect.classify({ text: 'good morning team', mentions: [] });
    assert.equal(r.isLead, false);
    assert.equal(r.reason, 'not_a_lead');
  });

  test('a mention with no phone number is not a lead', () => {
    // Ordinary conversation that happens to tag someone.
    const r = detect.classify({ text: '@919812345678 please call him', mentions: [RAHUL] });
    assert.equal(r.isLead, false);
    assert.equal(r.reason, 'no_phone');
  });

  test('a phone with no mention is a lead, but held (Q6)', () => {
    // Held rather than skipped — the information is real, only the assignee is
    // missing, and a human can supply that.
    const r = detect.classify({ text: 'Priya Sharma\n9876543210', mentions: [] });
    assert.equal(r.isLead, true);
    assert.equal(r.reason, 'no_mention');
  });

  test('two mentions are held for clarification (Q9)', () => {
    const r = detect.classify({
      text: 'Priya Sharma 9876543210 @919812345678 @919999888877',
      mentions: [RAHUL, PRIYA]
    });
    assert.equal(r.isLead, true);
    assert.equal(r.reason, 'multiple_mentions');
  });
});

describe('name extraction — best effort, never invented', () => {
  test('an explicit Name: label wins', () => {
    const r = detect.classify({
      text: 'New lead @919812345678\nName: Priya Sharma\nPhone: 9876543210',
      mentions: [RAHUL]
    });
    assert.equal(r.name, 'Priya Sharma');
  });

  test('falls back to the first name-shaped line', () => {
    assert.equal(
      detect.extractName('New lead\nRohit Verma\n9876543210'),
      'Rohit Verma'
    );
  });

  test('does not mistake filler words for a name', () => {
    // A lead filed under "Urgent" or "Sir" is worse than one waiting for review.
    for (const text of ['New lead\n9876543210', 'Urgent\n9876543210',
                        'Sir\n9876543210', 'please call\n9876543210']) {
      assert.equal(detect.extractName(text), null, `should find no name in "${text}"`);
    }
  });

  test('does not mistake a labelled field for a name', () => {
    assert.equal(detect.extractName('City: Delhi\n9876543210'), null);
  });

  test('does not mistake a sentence for a name', () => {
    assert.equal(detect.extractName('call him tomorrow after six\n9876543210'), null);
  });

  test('handles names with initials and apostrophes', () => {
    assert.equal(detect.extractName('R. K. Sharma\n9876543210'), 'R. K. Sharma');
    assert.equal(detect.extractName("D'Souza Maria\n9876543210"), "D'Souza Maria");
  });

  test('a phone number alone is a complete lead — no name required', () => {
    // Phone is the identity. Holding a lead for a missing name was wrong: a lead
    // shared as just a number is complete, and the name can arrive later.
    const r = detect.classify({ text: '9876543210 @919812345678', mentions: [RAHUL] });
    assert.equal(r.isLead, true);
    assert.equal(r.name, null);
    assert.equal(r.reason, null, 'must not be held');
  });

  test('strips the mention placeholder before looking for a name', () => {
    // The body renders a mention as "@919812345678"; without stripping it, that
    // line could be mistaken for content.
    assert.equal(
      detect.extractName('@919812345678\nAnjali Mehta\n9876543210'),
      'Anjali Mehta'
    );
  });
});

describe('classify — structured fields and remark text', () => {
  test('labelled fields are picked up alongside the lead', () => {
    const r = detect.classify({
      text: 'New lead @919812345678\nPriya Sharma\n9876543210\nUniversity: DU\nCourse: MBA',
      mentions: [RAHUL]
    });
    assert.equal(r.fields.university, 'DU');
    assert.equal(r.fields.target_degree, 'MBA');
  });

  test('unrecognised text becomes remark material, never lost', () => {
    const r = detect.classify({
      text: 'New lead @919812345678\nPriya Sharma\n9876543210\nvery interested, call after 6',
      mentions: [RAHUL]
    });
    assert.match(r.remarkText, /very interested/);
  });

  test('an unknown label survives as a remark with its label intact', () => {
    const r = detect.classify({
      text: 'Priya Sharma\n9876543210 @919812345678\nBudget Range: 20L',
      mentions: [RAHUL]
    });
    assert.equal(r.fields.budget_range, undefined);
    assert.match(r.remarkText, /Budget Range: 20L/);
  });

  test('a second phone number is kept separately, not discarded', () => {
    const r = detect.classify({
      text: 'Priya Sharma\n9876543210\nalt 9812345670 @919812345678',
      mentions: [RAHUL]
    });
    assert.equal(r.phone, '+919876543210');
    assert.deepEqual(r.extraPhones, ['+919812345670']);
  });
});

describe('institutions and situation lines (from live messages)', () => {
  test('a university is not a person, and fills the university field', () => {
    // Seen live: "SRM University" was filed as the lead's NAME, and the
    // university field left empty. The keyword makes this unambiguous.
    const r = detect.classify({
      text: '6290 690 498\n\nSRM University \n\nListed in PNB Bank \n\n@x',
      mentions: [RAHUL]
    });
    assert.equal(r.name, null, 'must not be used as a name');
    assert.equal(r.fields.university, 'SRM University');
    assert.equal(r.phone, '+916290690498');
  });

  test('a line about a bank is not a person either', () => {
    assert.equal(detect.extractName('9876543210\nListed in PNB Bank'), null);
    assert.equal(detect.extractName('9876543210\nSBI rejected'), null);
  });

  test('name, institution and amount together', () => {
    const r = detect.classify({
      text: '9007570563\nGanpati Podder\nIDST college\nBDS course\n8 Lacs',
      mentions: [RAHUL]
    });
    assert.equal(r.name, 'Ganpati Podder');
    assert.equal(r.fields.university, 'IDST college');
    assert.equal(r.fields.loan_amount, '8 Lakh');
  });

  test('a sentence mentioning a college is not the college name', () => {
    // It belongs in remarks, where a human reads it whole.
    assert.equal(
      detect.findInstitution('he studied at SRM University last year and wants to go abroad'),
      null
    );
  });

  test('a real name is still found', () => {
    assert.equal(detect.extractName('98718 48226\nRaghav'), 'Raghav');
  });
});
