const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-groups.db');
process.env.DB_PATH = TEST_DB;

const db = require('../src/db');
const repo = require('../src/db/repositories');

function reset() {
  db.close?.();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
  db.init();
}

const names = (rows) => rows.map((g) => g.name).sort();

describe('group membership', () => {
  beforeEach(reset);
  after(() => {
    db.close?.();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
  });

  test('groups another linked number was in are hidden once WhatsApp lists the real ones', () => {
    // What happened on 10 Sep 2026: a different number was linked during setup.
    repo.groups.upsert('fmc-1@g.us', 'Avanse - FMC');
    repo.groups.upsert('fmc-2@g.us', 'Axis Bank - Vikas Team');

    const result = repo.groups.syncMembership([
      { id: 'agroha@g.us', name: 'AGROHA Noida Chapter' },
      { id: 'invest@g.us', name: 'Global Investing Community' }
    ]);

    assert.deepStrictEqual(result, { members: 2, markedLeft: 2 });
    assert.deepStrictEqual(names(repo.groups.members()),
      ['AGROHA Noida Chapter', 'Global Investing Community']);
    assert.strictEqual(repo.groups.leftCount(), 2);
  });

  test('a left group is kept, so leads that point at it still resolve', () => {
    const g = repo.groups.upsert('fmc-1@g.us', 'Avanse - FMC');
    repo.groups.syncMembership([{ id: 'agroha@g.us', name: 'AGROHA' }]);

    assert.ok(repo.groups.all().find((row) => row.id === g.id));
    assert.ok(repo.groups.byWaId('fmc-1@g.us').left_at);
  });

  test('a left group stops being monitored, and comes back with its settings when rejoined', () => {
    const g = repo.groups.upsert('home@g.us', 'In-house');
    repo.groups.setActive(g.id, true);
    repo.groups.setSendEnabled(g.id, true);

    repo.groups.syncMembership([{ id: 'other@g.us', name: 'Other' }]);
    assert.strictEqual(repo.groups.active().length, 0);

    repo.groups.syncMembership([{ id: 'home@g.us', name: 'In-house' }]);
    const back = repo.groups.byWaId('home@g.us');
    assert.strictEqual(back.left_at, null);
    assert.strictEqual(back.is_active, 1);
    assert.strictEqual(back.send_enabled, 1);
    assert.strictEqual(repo.groups.active().length, 1);
  });

  test('a message arriving from a group means the number is in it', () => {
    repo.groups.upsert('home@g.us', 'In-house');
    repo.groups.syncMembership([{ id: 'other@g.us', name: 'Other' }]);
    assert.ok(repo.groups.byWaId('home@g.us').left_at);

    // The orchestrator upserts on every incoming group message.
    repo.groups.upsert('home@g.us', 'In-house');
    assert.strictEqual(repo.groups.byWaId('home@g.us').left_at, null);
  });

  test('an empty list from WhatsApp never marks everything as left', () => {
    const g = repo.groups.upsert('home@g.us', 'In-house');
    repo.groups.setActive(g.id, true);

    assert.deepStrictEqual(repo.groups.syncMembership([]),
      { members: 0, markedLeft: 0 });
    assert.strictEqual(repo.groups.active().length, 1);
    assert.strictEqual(repo.groups.leftCount(), 0);
  });
});
