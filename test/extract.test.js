/**
 * Lead-detail extraction from a DM conversation.
 *
 * The model is stubbed here on purpose. What matters is not whether the model is
 * clever — that is checked by hand against the real API — but that whatever it
 * returns is put through the same gate a typed label goes through, so a bad
 * extraction can only ever cost an empty field, never a wrong one.
 */
const { test, describe, mock } = require('node:test');
const assert = require('node:assert');

const openrouter = require('../src/ai/openrouter');
const { extractFields } = require('../src/ai/extract');

/** Make the model return exactly this, as its raw text. */
function modelReturns(text) {
  mock.method(openrouter, 'chat', async () => text);
}

const CHAT = [{ role: 'user', content: 'i need 10kw for my factory' }];

describe('extraction reads what the customer said', () => {
  test('a clean answer becomes typed fields', async (t) => {
    t.after(() => mock.restoreAll());
    modelReturns(JSON.stringify({
      city: 'Pune', application_industry: 'factory',
      load_capacity_kw: 10, backup_duration_hours: 4,
      solar_present: true, solar_capacity_kw: 3
    }));

    const { fields } = await extractFields(CHAT);

    assert.equal(fields.city, 'Pune');
    assert.equal(fields.load_capacity_kw, 10);
    assert.equal(typeof fields.load_capacity_kw, 'number');
    assert.equal(fields.solar_present, true);
    assert.equal(typeof fields.solar_present, 'boolean');
  });

  test('a code fence around the JSON is tolerated', async (t) => {
    t.after(() => mock.restoreAll());
    modelReturns('```json\n{"city":"Delhi"}\n```');
    const { fields } = await extractFields(CHAT);
    assert.equal(fields.city, 'Delhi');
  });

  test('nothing stated means nothing written', async (t) => {
    t.after(() => mock.restoreAll());
    modelReturns('{}');
    const { fields } = await extractFields(CHAT);
    assert.deepEqual(fields, {});
  });
});

describe('extraction cannot write what a typed label could not', () => {
  test('a value that is not a number is refused, not coerced to garbage', async (t) => {
    t.after(() => mock.restoreAll());
    modelReturns(JSON.stringify({ load_capacity_kw: 'a big load' }));

    const { fields, refused } = await extractFields(CHAT);

    assert.equal(fields.load_capacity_kw, undefined);
    assert.equal(refused[0].reason, 'not_a_number');
  });

  test('a maybe is not a yes', async (t) => {
    t.after(() => mock.restoreAll());
    modelReturns(JSON.stringify({ solar_present: 'maybe' }));

    const { fields, refused } = await extractFields(CHAT);

    assert.equal(fields.solar_present, undefined);
    assert.equal(refused[0].reason, 'not_yes_or_no');
  });

  test('a field nobody asked for is never written, however confident the model', async (t) => {
    t.after(() => mock.restoreAll());
    // current_stage is in NEVER_SEND (R5) and must not be reachable this way.
    modelReturns(JSON.stringify({ current_stage: 'sanctioned', phone: '+919999999999' }));

    const { fields, refused } = await extractFields(CHAT);

    assert.deepEqual(fields, {});
    assert.equal(refused.length, 2);
    assert.ok(refused.every((r) => r.reason === 'not_extractable'));
  });

  test('a model that returns prose instead of JSON costs nothing', async (t) => {
    t.after(() => mock.restoreAll());
    modelReturns('Sure! The customer seems to want a 10kW system.');

    const { fields } = await extractFields(CHAT);

    assert.deepEqual(fields, {});
  });

  test('a model that returns a list instead of an object costs nothing', async (t) => {
    t.after(() => mock.restoreAll());
    modelReturns('[{"city":"Pune"}]');
    const { fields } = await extractFields(CHAT);
    assert.deepEqual(fields, {});
  });

  test('a failed model call is silent, not an exception', async (t) => {
    t.after(() => mock.restoreAll());
    // openrouter.chat returns null on any failure — it never throws.
    mock.method(openrouter, 'chat', async () => null);

    const { fields } = await extractFields(CHAT);

    assert.deepEqual(fields, {});
  });

  test('an empty conversation never calls the model at all', async (t) => {
    t.after(() => mock.restoreAll());
    const chat = mock.method(openrouter, 'chat', async () => '{}');

    await extractFields([]);

    assert.equal(chat.mock.callCount(), 0);
  });
});
