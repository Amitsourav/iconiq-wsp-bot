/**
 * The two rules that decide whether a silent connection is repaired and whether
 * a recovered message is acted on.
 *
 * Both exist because of 2026-09-19, when the socket stopped receiving at 11:37
 * and nothing noticed until 16:39. The liveness probe could not notice: it asks
 * WhatsApp whether it is there, and WhatsApp answered yes for five hours while
 * delivering nothing. Then the reconnect that finally fixed it handed back 23
 * missed messages and every one was discarded as history.
 *
 * So these are tested as pure decisions, with the clock and the hour injected —
 * "quiet at 3am is fine, quiet at 3pm is not" is not something to verify by
 * waiting twelve hours.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { withinReplayWindow, soundsDeaf } = require('../src/whatsapp/client');
const { config } = require('../src/config');

/** A WhatsApp timestamp (seconds) for a message sent this many hours ago. */
const hoursAgo = (hours, now) => Math.floor((now - hours * 3_600_000) / 1000);

describe('acting on a replayed message', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');

  test('a message missed minutes ago is still owed a reply', () => {
    assert.equal(withinReplayWindow(hoursAgo(0.5, now), now), true);
  });

  test('a message from this morning is still owed a reply', () => {
    // The actual case: five hours of customers, recovered and then binned.
    assert.equal(withinReplayWindow(hoursAgo(5, now), now), true);
  });

  test('a message from last month is history, not a missed reply', () => {
    assert.equal(withinReplayWindow(hoursAgo(24 * 30, now), now), false);
  });

  test('the boundary is the configured window', () => {
    const edge = config.whatsapp.replayMaxAgeHours;
    assert.equal(withinReplayWindow(hoursAgo(edge - 0.1, now), now), true);
    assert.equal(withinReplayWindow(hoursAgo(edge + 0.1, now), now), false);
  });

  test('a timestamp in the future is clock skew, not staleness', () => {
    // Refusing these would silently drop live messages whenever the phone's
    // clock ran a little ahead of ours.
    assert.equal(withinReplayWindow(hoursAgo(-1, now), now), true);
  });

  test('a message with no timestamp is not acted on', () => {
    assert.equal(withinReplayWindow(0, now), false);
    assert.equal(withinReplayWindow(undefined, now), false);
  });
});

describe('noticing a deaf connection', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const minutesAgo = (minutes) => now - minutes * 60_000;
  const workingHour = config.whatsapp.activeFromHour + 1;
  const nightHour = (config.whatsapp.activeUntilHour + 1) % 24;

  test('a long working-hours silence means deaf', () => {
    assert.equal(soundsDeaf({
      lastMessageAt: minutesAgo(config.whatsapp.silenceMinutes + 5),
      now,
      hour: workingHour
    }), true);
  });

  test('an ordinary gap between customers is not deafness', () => {
    assert.equal(soundsDeaf({
      lastMessageAt: minutesAgo(10), now, hour: workingHour
    }), false);
  });

  test('the same silence at night is just night', () => {
    // Reconnecting every 45 minutes until morning would be churn with nothing
    // to gain, and each reconnect costs a burst of session renegotiation.
    assert.equal(soundsDeaf({
      lastMessageAt: minutesAgo(600), now, hour: nightHour
    }), false);
  });

  test('a connection that has heard nothing yet is not condemned for it', () => {
    // Otherwise the first watchdog tick after a fresh link would force a
    // reconnect before anyone had a chance to write in.
    assert.equal(soundsDeaf({ lastMessageAt: null, now, hour: workingHour }), false);
  });

  test('the boundary is the configured silence window', () => {
    const limit = config.whatsapp.silenceMinutes;
    assert.equal(soundsDeaf({
      lastMessageAt: minutesAgo(limit - 1), now, hour: workingHour
    }), false);
    assert.equal(soundsDeaf({
      lastMessageAt: minutesAgo(limit), now, hour: workingHour
    }), true);
  });

  test('the first and last working hours are covered', () => {
    const quiet = minutesAgo(config.whatsapp.silenceMinutes + 5);
    assert.equal(soundsDeaf({
      lastMessageAt: quiet, now, hour: config.whatsapp.activeFromHour
    }), true, 'the window opens at activeFromHour');
    assert.equal(soundsDeaf({
      lastMessageAt: quiet, now, hour: config.whatsapp.activeUntilHour
    }), false, 'and closes at activeUntilHour');
  });
});
