const { test, describe } = require('node:test');
const assert = require('node:assert');
const detect = require('../src/pipeline/detect');

/**
 * Every message shape actually posted in the group, with the result we want.
 *
 * This is the regression suite that matters most: it is not invented examples but
 * the real thing, and each entry was added because the parser once got it wrong or
 * because it is a shape we must not break.
 *
 * Numbers and names are as posted — this is the owner's own team's traffic.
 */
const MENTION = '+918796222415';

const CASES = [
  {
    label: 'phone only',
    text: '97179 34641\n\n@x',
    want: { phone: '+919717934641', name: null }
  },
  {
    label: 'phone then name',
    text: '97417 40808\nZaid \n\n@x',
    want: { phone: '+919741740808', name: 'Zaid' }
  },
  {
    label: 'institution on its own line, no name anywhere',
    // Was filed as the lead's NAME, leaving the university field empty.
    text: '6290 690 498\n\nSRM University \n\nListed in PNB Bank \n\n@x',
    want: { phone: '+916290690498', name: null, university: 'SRM University' }
  },
  {
    label: 'name, college, course and amount',
    text: '90075 70563\nGanpati Podder\n\n8 Lacs\n\nIDST college\n\nBDS course\n\n@x',
    want: {
      phone: '+919007570563', name: 'Ganpati Podder',
      university: 'IDST college', target_degree: 'BDS course', loan_amount: '8 Lakh'
    }
  },
  {
    label: 'amount spelled "lkh"',
    text: '98718 48226\nRaghav \n\nCourse level 7 bachelors \n30 lkh \n\n@x',
    want: { name: 'Raghav', loan_amount: '30 Lakh' }
  },
  {
    label: 'course with a country',
    text: '93540 83384\nJitender Baghel \n\nBachelors in Australia \n\n@x',
    want: { name: 'Jitender Baghel', target_degree: 'Bachelors in Australia' }
  },
  {
    label: 'initials as a name',
    text: '63634 29113\nANR\n\nMBBS India \n\n50 Lacs \n\n@x',
    want: { name: 'ANR', target_degree: 'MBBS India', loan_amount: '50 Lakh' }
  },
  {
    label: 'name and number on one line',
    text: '8178261030 Sunil Bohet\n@x',
    want: { phone: '+918178261030', name: 'Sunil Bohet' }
  },
  {
    label: 'a status line, not a lead detail',
    // "Existing lead." was being read as the person's name.
    text: '78668 78035\n\nExisting lead. \n\nWhoever the counsellor is please call',
    want: { phone: '+917866878035', name: null }
  },
  {
    label: 'unlabelled multi-field lead',
    text: 'jaanvi dixit \ndilip dixit \n84334 85292\nLaction Agra \nGla mathura \nbtech \n7 Lakhs\n\n@x',
    want: {
      phone: '+918433485292', name: 'jaanvi dixit',
      target_degree: 'btech', loan_amount: '7 Lakh'
    }
  }
];

describe('real messages from the group', () => {
  for (const { label, text, want } of CASES) {
    test(label, () => {
      const got = detect.classify({ text, mentions: [MENTION] });
      for (const [field, expected] of Object.entries(want)) {
        const actual = field in got ? got[field] : got.fields[field];
        assert.deepEqual(actual ?? null, expected,
          `${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    });
  }

  test('a person is never given an institution or course as their name', () => {
    for (const line of ['SRM University', 'IDST college', 'BDS course', 'MBBS India',
                        'Listed in PNB Bank', 'SBI rejected', 'Existing lead']) {
      assert.equal(detect.looksLikeName(line), false, `"${line}" must not be a name`);
    }
  });

  test('real names still pass', () => {
    for (const line of ['Ganpati Podder', 'Jitender Baghel', 'Sunil Bohet',
                        'jaanvi dixit', 'Raghav', 'Prince', 'R. K. Sharma']) {
      assert.equal(detect.looksLikeName(line), true, `"${line}" must be a name`);
    }
  });
});

describe('things that describe a lead are never its name', () => {
  // Every entry here was found being read as a person's name.
  const NOT_PEOPLE = [
    'Sanctioned already', 'Docs pending', 'File login', 'Not interested',
    'Number switch off', 'Wrong number', 'DNP', 'Offer letter received',
    'Visa applied', 'Fees paid', 'Collateral yes', 'Second time',
    'Father farmer', 'Mother housewife', 'Co applicant father',
    'September intake', 'Fall 2026', 'Referred by Ankit', 'Website lead',
    'Location Agra', 'Laction Agra', 'Bihar', 'Delhi NCR',
    'Chandigarh University', 'IIT Delhi', 'Amity Noida', 'Delhi Public School'
  ];

  for (const line of NOT_PEOPLE) {
    test(`"${line}"`, () => {
      assert.equal(detect.looksLikeName(line), false);
    });
  }
});

describe('real names survive the filtering', () => {
  const PEOPLE = [
    'Ganpati Podder', 'jaanvi dixit', 'Sunil Bohet', 'Anshu Raj', 'Raghav',
    'Prince', 'ANR', 'R. K. Sharma', "D'Souza Maria", 'Md Arif', 'Sri Lakshmi',
    'Abhishek Dabas', 'Ajoy Dhar', 'Vikash', 'Hari', 'Insha', 'Zaid',
    'Jitender Baghel', 'Priya', 'Mohammed Salim Khan'
  ];

  for (const line of PEOPLE) {
    test(`"${line}"`, () => {
      assert.equal(detect.looksLikeName(line), true);
    });
  }
});

describe('known limit: an institution with no marker word', () => {
  test('is indistinguishable from a name, and is documented as such', () => {
    // "Gla mathura" and "Lovely Professional" are two capitalised words with
    // nothing to separate them from a person. No rule can catch these — they need
    // either a label from the sender or an AI reading the message. Asserted here
    // so the limitation is visible rather than forgotten.
    assert.equal(detect.looksLikeName('Gla mathura'), true);
    assert.equal(detect.looksLikeName('Lovely Professional'), true);
  });
});

describe('bullet-list leads (real message)', () => {
  // WhatsApp renders bullets with invisible joiners around them, so these lines
  // begin with "•⁠  ⁠" rather than a letter. Before this was handled, every
  // label rule failed and the junk ended up inside stored values.
  const BULLETED = [
    '•⁠  ⁠Student : Nihal Himsarkar',
    '•⁠  ⁠Phone Number : 93074 28677',
    '•⁠  ⁠Location : Maharashtra ',
    '•⁠  ⁠Bachelors ',
    '•⁠  ⁠Upgrad program ',
    '•⁠  ⁠1 yr online and 3 yrs in Boston ',
    '•⁠  ⁠52 Lacs + 60 Lacs ',
    '•⁠  ⁠Parent - Coapplicant ',
    '•⁠  ⁠Salaried father - 80k gross per month - 720 CIBIL ',
    '•⁠  ⁠Mom : 30-40k per month (files ITR) - 740 CIBIL'
  ].join('\n');

  test('reads the name through the bullet', () => {
    const r = detect.classify({ text: BULLETED, mentions: ['+918796222415'] });
    assert.equal(r.name, 'Nihal Himsarkar');
  });

  test('reads the phone', () => {
    const r = detect.classify({ text: BULLETED, mentions: ['+918796222415'] });
    assert.equal(r.phone, '+919307428677');
  });

  test('stored values carry no bullet characters', () => {
    // "•⁠ ⁠Bachelors" was being written into the CRM verbatim.
    const r = detect.classify({ text: BULLETED, mentions: ['+918796222415'] });
    for (const [field, value] of Object.entries(r.fields)) {
      assert.doesNotMatch(String(value), /[•‣▪]/, `${field} contains a bullet`);
      assert.equal(String(value), String(value).trim(), `${field} has stray spacing`);
    }
    assert.equal(r.fields.target_degree, 'Bachelors');
  });

  test("a parent's salary is never mistaken for the loan", () => {
    // The message contains "80k gross per month" and "30-40k per month". Those
    // are incomes, and treating either as the loan would be badly wrong.
    const r = detect.classify({ text: BULLETED, mentions: ['+918796222415'] });
    assert.equal(r.fields.loan_amount, undefined);
  });
});

describe('bulk lead lists (real message)', () => {
  // Exactly as posted: number first, name second, and "Student" standing in
  // wherever the name was not known. Fifteen leads under one tag.
  const BULK = [
    '917788883939    AliceKhemka',
    '919019531381    AnuragHardi',
    '919007717838    D',
    '919217189006    Mehak',
    '918604001600    sagarika',
    '918498849836    Student',
    '917428393768    Student',
    '919818389738    Student',
    '919793973660    Student',
    '918668347106    Student'
  ].join('\n');

  test('splits into one lead per line', () => {
    const rows = detect.splitLeads(BULK, []);
    assert.equal(rows.length, 10);
  });

  test('reads the names that are real', () => {
    const rows = detect.splitLeads(BULK, []);
    assert.equal(rows[0].name, 'AliceKhemka');
    assert.equal(rows[1].name, 'AnuragHardi');
    assert.equal(rows[3].name, 'Mehak');
  });

  test('"Student" and "D" are not stored as names', () => {
    // They are placeholders. Such a lead is identified by its number, like any
    // other lead with no usable name.
    const rows = detect.splitLeads(BULK, []);
    assert.equal(rows[2].name, null, '"D" is too short to be a name');
    assert.equal(rows[5].name, null, '"Student" is a placeholder');
  });

  test('every number is captured correctly', () => {
    const rows = detect.splitLeads(BULK, []);
    assert.equal(rows[0].phone, '+917788883939');
    assert.equal(rows[9].phone, '+918668347106');
  });

  test('a lead with one alternate number is still NOT split', () => {
    // The case this rule exists to protect: a phantom lead on the borrower's
    // second number would sit in the CRM forever, assigned and never converting.
    assert.equal(detect.splitLeads('Priya Sharma\n9876543210\nalt 9812345670', []), null);
    assert.equal(detect.splitLeads('Priya 9876543210 9812345670', []), null);
  });
});
