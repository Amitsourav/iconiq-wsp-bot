const { test, describe } = require('node:test');
const assert = require('node:assert');

const logger = require('../src/logger');
const noise = require('../src/whatsapp/signalNoise');

/** Capture what the logger writes while fn runs. */
function captureLogs(fn) {
  const lines = [];
  const off = logger.subscribe((entry) => lines.push(entry));
  try { fn(); } finally { off(); }
  return lines;
}

describe('libsignal console noise', () => {
  test('the lines seen in production are recognised', () => {
    // Copied from the Railway log of 22 Nov 2026.
    assert.strictEqual(noise.classify(['Failed to decrypt message with any known session...']),
      'decrypt failed');
    assert.strictEqual(
      noise.classify(['Session error:SessionError: Over 2000 messages into the future! '
        + 'SessionError: Over 2000 messages into the future!', 'stack...']),
      'session error: Over 2000 messages into the future!');
    assert.strictEqual(noise.classify(['Closing session:', { some: 'object' }]), 'session closed');
    assert.strictEqual(noise.classify(['Removing old closed session:', {}]), 'old session removed');
  });

  test('our own messages and anything unknown pass through', () => {
    assert.strictEqual(noise.classify(['\x1b[31m2026-11-22T05:40:22.840Z [ERROR] Nothing received']), null);
    assert.strictEqual(noise.classify(['Some other library failed']), null);
    assert.strictEqual(noise.classify([new Error('x')]), null);
    assert.strictEqual(noise.classify([]), null);
  });

  test('the first of a kind is logged at once, the rest are summarised', () => {
    const lines = captureLogs(() => {
      for (let i = 0; i < 500; i++) noise.record('test kind A');
      noise.record('test kind B');
      noise.flush();
      noise.flush(); // nothing new — says nothing
    });

    const text = lines.map((l) => l.message);
    assert.strictEqual(text.length, 3);
    assert.match(text[0], /test kind A/);
    assert.match(text[1], /test kind B/);
    assert.match(text[2], /last hour: test kind A ×499$/);
  });

  test('once installed, a libsignal line never reaches the console', () => {
    const printed = [];
    const original = console.error;
    console.error = (...args) => printed.push(args);
    try {
      noise.install();
      const lines = captureLogs(() => {
        console.error('Failed to decrypt message with any known session...');
        console.error('a real problem');
      });
      assert.deepStrictEqual(printed, [['a real problem']]);
      assert.ok(lines.length <= 1); // the first-seen notice, unless an earlier test saw it
    } finally {
      console.error = original;
    }
  });
});
