const { test, describe } = require('node:test');
const assert = require('node:assert');

const phone = require('../src/pipeline/phone');
const noise = require('../src/pipeline/noise');
const labels = require('../src/pipeline/labels');

describe('phone.normalise — mirrors the CRM (C14)', () => {
  test('all four Indian formats reach the same E.164', () => {
    for (const input of ['9876543210', '919876543210', '+919876543210',
                         '09876543210', '00919876543210', '+91 98765 43210',
                         '98765-43210']) {
      assert.equal(phone.normalise(input).e164, '+919876543210', `failed on ${input}`);
    }
  });

  test('rejects what is not a phone number at all', () => {
    for (const input of ['12345', '98765 43210 call after 6', '1234567890',
                         '', null]) {
      assert.equal(phone.normalise(input).normalised, false, `should reject ${input}`);
    }
  });

  test('accepts an overseas number written with its country code', () => {
    // Changed 2 Sep 2026. These were rejected because the CRM stores a non-Indian
    // number verbatim rather than normalising it (C14), so it deduplicates only
    // against an identical string. That is a weaker guarantee, but the cost of
    // the old rule was a real lead dropped in silence: a Kuwait number posted
    // twice in the group, read as "not a lead" both times.
    for (const [input, expected] of [
      ['+96569950748', '+96569950748'],
      ['+971 50 123 4567', '+971501234567'],
      ['+1 415 555 2671', '+14155552671']
    ]) {
      const r = phone.normalise(input);
      assert.equal(r.e164, expected, `failed on ${input}`);
      assert.equal(r.international, true, `${input} should be flagged international`);
    }
  });

  test('an overseas number needs the +, and a bare run is never guessed at', () => {
    // The + is the whole safety catch. Without it an eleven-digit run could be an
    // account number, an ID, or two numbers that ran together — and inventing a
    // lead from one puts a record in the CRM nobody can act on.
    assert.equal(phone.normalise('96569950748').normalised, false);
    assert.equal(phone.normalise('00 965 6995 0748').normalised, false);
  });

  test('a +91 number still has to be a real mobile', () => {
    // Must not fall through to the international branch: "+911234567890" claims
    // to be Indian, and accepting it would create a lead under a number that
    // cannot be called.
    assert.equal(phone.normalise('+911234567890').normalised, false);
    assert.equal(phone.normalise('+919876543210').e164, '+919876543210');
    assert.equal(phone.normalise('+919876543210').international, false);
  });

  test('findUnreadable tells a failed lead from ordinary chat', () => {
    // Fires on something number-shaped that could not be used...
    assert.deepEqual(
      phone.findUnreadable('Ajaj Shaikh\n0096569950748\najaz@gmail.com'),
      ['0096569950748']
    );
    // ...and stays quiet on the tagged chatter that makes up most of what the
    // bot skips. A mention renders in the body as a 15-digit LID, which would
    // otherwise read as a mangled number and answer every tagged message.
    for (const chatter of [
      '@192703069470725 @71408830918849 apne apne cases update kro',
      'updated in sheet @126851909435470 sir',
      'All leads status updates, except Himanshu.\n@126851909435470 sir FYI'
    ]) {
      assert.deepEqual(phone.findUnreadable(chatter), [], `should ignore: ${chatter}`);
    }
    // A number it CAN read is not unreadable.
    assert.deepEqual(phone.findUnreadable('lead +96569950748'), []);
  });

  test('rejects Indian numbers not starting 6-9', () => {
    assert.equal(phone.normalise('1234567890').normalised, false);
    assert.equal(phone.normalise('5876543210').normalised, false);
  });
});

describe('phone.extract — conservative by design', () => {
  test('finds a number in a lead message', () => {
    assert.deepEqual(
      phone.extract('New lead\nPriya Sharma\n9876543210'),
      ['+919876543210']
    );
  });

  test('does not mistake pincodes, years or amounts for phones', () => {
    // A junk lead in the CRM is worse than a missed one: it looks real.
    assert.deepEqual(phone.extract('Pincode 110001, passing 2024, needs 1500000'), []);
  });

  test('deduplicates the same number written two ways', () => {
    assert.deepEqual(
      phone.extract('call 9876543210 or +91 98765 43210'),
      ['+919876543210']
    );
  });

  test('ignores over-long digit runs', () => {
    assert.deepEqual(phone.extract('account 123456789012345678'), []);
  });
});

describe('phone.fromJid — mention resolution', () => {
  test('extracts from a WhatsApp JID', () => {
    assert.equal(phone.fromJid('919876543210@s.whatsapp.net'), '+919876543210');
    assert.equal(phone.fromJid('919876543210:12@s.whatsapp.net'), '+919876543210');
  });
});

describe('noise.classify — whole-message only (R11.1)', () => {
  test('filters acknowledgements', () => {
    for (const text of ['ok', 'OK', 'done', 'Thanks!', 'ji sir', 'hmm', 'yes', 'noted']) {
      assert.equal(noise.isNoise(text), true, `should filter "${text}"`);
    }
  });

  test('filters emoji-only and punctuation-only', () => {
    for (const text of ['👍', '👍👍', '🙏🏽', '...', '??']) {
      assert.equal(noise.isNoise(text), true, `should filter "${text}"`);
    }
  });

  test('NEVER filters a noise word inside a longer message', () => {
    // The critical property. A substring match here would silently discard real
    // information, which is the exact failure R9 was chosen to avoid.
    for (const text of ['documents done', 'ok he will pay 5 lakh', 'done with sbi login',
                        'no collateral available', 'yes he has a cosigner']) {
      assert.equal(noise.isNoise(text), false, `must NOT filter "${text}"`);
    }
  });

  test('keeps real information', () => {
    assert.equal(noise.isNoise('University: Delhi University'), false);
    assert.equal(noise.isNoise('needs 15 lakh for MBA'), false);
  });
});

describe('labels.parse — structured updates', () => {
  test('parses a labelled line', () => {
    const r = labels.parse('University: Delhi University');
    assert.deepEqual(r.fields, { university: 'Delhi University' });
  });

  test('accepts all three separators (R11.3)', () => {
    for (const sep of [':', '-', '=']) {
      const r = labels.parse(`University ${sep} Delhi University`);
      assert.deepEqual(r.fields, { university: 'Delhi University' }, `failed on "${sep}"`);
    }
  });

  test('aliases resolve to one field (D1)', () => {
    // college_name is never written — every variant lands on `university`.
    for (const label of ['College', 'Clg', 'University', 'Univ', 'college name']) {
      const r = labels.parse(`${label}: Delhi University`);
      assert.deepEqual(r.fields, { university: 'Delhi University' }, `failed on "${label}"`);
    }
  });

  test('Course maps to target_degree (D2)', () => {
    assert.deepEqual(labels.parse('Course: MBA').fields, { target_degree: 'MBA' });
  });

  test('Country maps to preferred_countries as an array (D3)', () => {
    assert.deepEqual(labels.parse('Country: UK, Canada').fields,
                     { preferred_countries: ['UK', 'Canada'] });
  });

  test('several fields in one message (R11.4)', () => {
    const r = labels.parse('University: DU\nCourse: MBA\nCity: Delhi');
    assert.deepEqual(r.fields,
      { university: 'DU', target_degree: 'MBA', city: 'Delhi' });
  });

  test('unknown labels are rejected, never dropped (R11.5)', () => {
    const r = labels.parse('Budget Range: 20L');
    assert.deepEqual(r.fields, {});
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].reason, 'unknown_label');
    assert.equal(r.rejected[0].value, '20L');
  });

  test('never writes protected fields', () => {
    // notes would destroy the AI call pipeline's history (C1); phone is identity
    // (C3); tags is replace-not-merge (C2). What matters is that nothing is
    // written — whether it was rejected as unknown or as protected is incidental,
    // and both guards are kept as defence in depth.
    for (const line of ['Notes: something', 'Phone: 9876543210', 'Tags: hot']) {
      const r = labels.parse(line);
      assert.deepEqual(r.fields, {}, `must not write from "${line}"`);
      assert.equal(r.rejected.length, 1, `must record rejection for "${line}"`);
    }
  });

  test('protected-field guard fires even if a label is mapped to one', () => {
    // Directly exercises the NEVER_WRITE branch, which the labels above bypass
    // because they are not in LABEL_MAP at all.
    const fields = require('../src/crm/fields');
    const original = fields.LABEL_MAP['temp test label'];
    fields.LABEL_MAP['temp test label'] = 'notes';
    try {
      const r = labels.parse('temp test label: destroy call history');
      assert.deepEqual(r.fields, {});
      assert.equal(r.rejected[0].reason, 'field_not_writable');
    } finally {
      if (original === undefined) delete fields.LABEL_MAP['temp test label'];
    }
  });

  test('locked lists match exactly or not at all (M6)', () => {
    assert.deepEqual(labels.parse('Bank: icici').fields, { bank_name: 'ICICI' });

    const bad = labels.parse('Bank: Some Random Bank');
    assert.deepEqual(bad.fields, {});
    assert.equal(bad.rejected[0].reason, 'not_in_locked_list');
  });

  test('truncates over-length values (C12)', () => {
    // Over-length input returns 500 from the CRM, not 422.
    const r = labels.parse(`Loan: ${'9'.repeat(80)}`);
    assert.equal(r.fields.loan_amount.length, 50);
  });

  test('unlabelled lines become remark material', () => {
    const r = labels.parse('she is very interested\nUniversity: DU');
    assert.deepEqual(r.fields, { university: 'DU' });
    assert.deepEqual(r.plain, ['she is very interested']);
  });

  test('numeric coercion and range checks', () => {
    assert.deepEqual(labels.parse('Percentage: 78.5').fields, { percentage: 78.5 });
    assert.deepEqual(labels.parse('Passing Year: 2024').fields, { passing_year: 2024 });
    assert.equal(labels.parse('Passing Year: 12').rejected[0].reason, 'out_of_range');
  });

  test('date conversion to YYYY-MM-DD', () => {
    assert.deepEqual(labels.parse('DOB: 15/08/1999').fields, { date_of_birth: '1999-08-15' });
    assert.deepEqual(labels.parse('DOB: 1999-08-15').fields, { date_of_birth: '1999-08-15' });
    assert.equal(labels.parse('DOB: sometime in 99').rejected[0].reason, 'unparsable_date');
  });

  test('a plain sentence with a colon is not mistaken for a label', () => {
    const r = labels.parse('told him: we will call tomorrow');
    assert.deepEqual(r.fields, {});
  });
});

describe('phone.extract — newline handling (regression)', () => {
  test('two numbers on adjacent lines are both found', () => {
    // A run allowed to span newlines merges them into one over-long run, which is
    // then rejected as too long — silently losing both numbers.
    assert.deepEqual(
      phone.extract('Priya\n9876543210\n9812345670'),
      ['+919876543210', '+919812345670']
    );
  });
});

describe('detect — mention placeholders are not the lead phone (regression)', () => {
  test("the mentioned employee's number is never taken as the lead's phone", () => {
    // The body renders a mention as "@919812345678". Without excluding mentioned
    // numbers, the lead is filed under the phone of the person it was assigned to.
    const detect = require('../src/pipeline/detect');
    const r = detect.classify({
      text: 'New lead @919812345678\nPriya Sharma\n9876543210',
      mentions: ['+919812345678']
    });
    assert.equal(r.phone, '+919876543210');
    assert.deepEqual(r.extraPhones, []);
  });
});
