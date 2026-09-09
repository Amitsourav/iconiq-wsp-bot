const { test, describe } = require('node:test');
const assert = require('node:assert');
const amount = require('../src/pipeline/amount');
const labels = require('../src/pipeline/labels');
const detect = require('../src/pipeline/detect');

describe('amount detection', () => {
  test('recognises Indian money forms', () => {
    const cases = {
      '7 Lakhs': '7 Lakh', '7 lakh': '7 Lakh', '7 lac': '7 Lakh', '15L': '15 Lakh',
      '1.5 cr': '1.5 Cr', '1.5 crore': '1.5 Cr', '50k': '50 K',
      '₹7,00,000': '₹7,00,000', 'Rs 700000': '₹700000', '7,00,000': '₹7,00,000'
    };
    for (const [input, expected] of Object.entries(cases)) {
      assert.equal(amount.detect(input).value, expected, `failed on "${input}"`);
    }
  });

  test('a bare number is NOT an amount', () => {
    // Requiring a marker is what keeps phone numbers, pincodes and years out of
    // the loan column. "700000" could be anything.
    for (const input of ['700000', '9876543210', '2024', '110001', '78']) {
      assert.equal(amount.detect(input).isAmount, false, `must reject "${input}"`);
    }
  });

  test('a sentence containing an amount is not an amount', () => {
    // It belongs in remarks, where a human reads it in context.
    for (const input of ['needs about 7 lakhs', 'told him 15L max', 'ok 7 lakh']) {
      assert.equal(amount.detect(input).isAmount, false, `must reject "${input}"`);
    }
  });

  test('ordinary replies are unaffected', () => {
    for (const input of ['ok', 'Delhi University', 'btech', 'done']) {
      assert.equal(amount.detect(input).isAmount, false);
    }
  });
});

describe('amount in a reply', () => {
  test('a reply that is just an amount sets loan_amount', () => {
    assert.deepEqual(labels.parse('7 Lakhs').fields, { loan_amount: '7 Lakh' });
    assert.deepEqual(labels.parse('15L').fields, { loan_amount: '15 Lakh' });
  });

  test('an explicit label still wins', () => {
    assert.deepEqual(labels.parse('Loan: 8 lakh').fields, { loan_amount: '8 lakh' });
  });

  test('a non-amount reply is still remark material', () => {
    const r = labels.parse('Delhi University');
    assert.deepEqual(r.fields, {});
    assert.deepEqual(r.plain, ['Delhi University']);
  });
});

describe('amount in a lead message', () => {
  test('picks the amount out of a real-shaped message', () => {
    // The actual format the team writes in: no labels anywhere.
    const r = detect.classify({
      text: 'jaanvi dixit\ndilip dixit\n84334 85292\nLaction Agra\nGla mathura\nbtech\n7 Lakhs',
      mentions: ['+919812345678']
    });
    assert.equal(r.fields.loan_amount, '7 Lakh');
    assert.equal(r.name, 'jaanvi dixit');
    assert.equal(r.phone, '+918433485292');
  });

  test('the amount line is not repeated in the remark', () => {
    const r = detect.classify({
      text: 'Priya Sharma\n9876543210\nGla mathura\n7 Lakhs',
      mentions: ['+919812345678']
    });
    assert.equal(r.fields.loan_amount, '7 Lakh');
    assert.ok(!/7 Lakhs/.test(r.remarkText || ''), 'must not duplicate into remarks');
    assert.match(r.remarkText, /Gla mathura/, 'but other detail is still kept');
  });
});

describe('several amounts in one message', () => {
  const REAL = 'Northeastern University Boston\nTution - 52 Lakhs\n'
    + 'living expenses - 60 lakhs\n\nTotal : 1.1 Cr';

  test('the total is the loan, not the first figure', () => {
    // From a real message. Taking the first amount would have filed a 1.1 crore
    // case as 52 lakh — wrong by half, and wrong in the direction that loses a
    // deal.
    const parsed = labels.parse(REAL);
    const inferred = detect.inferFields(REAL, parsed.fields);
    assert.equal({ ...parsed.fields, ...inferred.fields }.loan_amount, '1.1 Cr');
  });

  test('the breakdown does not reach the loan column', () => {
    const parsed = labels.parse(REAL);
    assert.ok(parsed.rejected.some((r) => r.label === 'Tution'));
    assert.ok(parsed.rejected.some((r) => r.label === 'living expenses'));
  });

  test('two figures and no total sets nothing', () => {
    const text = 'Priya Sharma\n52 Lakhs\n60 lakhs';
    const parsed = labels.parse(text);
    const inferred = detect.inferFields(text, parsed.fields);
    assert.equal({ ...parsed.fields, ...inferred.fields }.loan_amount, undefined);
  });

  test('but the figures are offered back so a human can choose', () => {
    const noTotal = 'Tution - 52 Lakhs\nliving expenses - 60 lakhs';
    const parsed = labels.parse(noTotal);
    // Amounts hide inside labels we could not place, not only on bare lines.
    assert.deepEqual(labels.amountCandidates(noTotal, parsed.rejected),
      ['52 Lakh', '60 Lakh']);
  });

  test('one figure is still taken without a label', () => {
    const text = '8 Lacs\nIDST college';
    const parsed = labels.parse(text);
    const inferred = detect.inferFields(text, parsed.fields);
    assert.equal({ ...parsed.fields, ...inferred.fields }.loan_amount, '8 Lakh');
  });

  test('Total and its variants all name the loan', () => {
    for (const label of ['Total', 'Total amount', 'Grand total', 'Loan required',
                         'Amount required', 'Requirement']) {
      assert.equal(labels.parse(`${label}: 1.1 Cr`).fields.loan_amount, '1.1 Cr',
        `failed on "${label}"`);
    }
  });
});
