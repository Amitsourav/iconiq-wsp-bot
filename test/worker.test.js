const { test, describe } = require('node:test');
const assert = require('node:assert');
const { dueForRetry } = require('../src/pipeline/worker');

describe('retry backoff', () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);

  test('a never-attempted row is due immediately', () => {
    assert.equal(dueForRetry({ attempts: 0, created_at: ago(0) }), true);
  });

  test('backoff doubles with each attempt', () => {
    // 1 attempt -> wait 1 min; 3 attempts -> wait 4 min.
    assert.equal(dueForRetry({ attempts: 1, updated_at: ago(30_000) }), false);
    assert.equal(dueForRetry({ attempts: 1, updated_at: ago(70_000) }), true);
    assert.equal(dueForRetry({ attempts: 3, updated_at: ago(3 * 60_000) }), false);
    assert.equal(dueForRetry({ attempts: 3, updated_at: ago(5 * 60_000) }), true);
  });

  test('backoff is capped at an hour', () => {
    // Without a cap, 8 attempts would mean a wait of over two hours.
    assert.equal(dueForRetry({ attempts: 20, updated_at: ago(61 * 60_000) }), true);
  });

  test('an unparsable timestamp retries rather than stalling forever', () => {
    assert.equal(dueForRetry({ attempts: 2, updated_at: 'nonsense' }), true);
  });
});
