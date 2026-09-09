/**
 * Noise filtering for replies (R11.1).
 *
 * A reply is noise only when the ENTIRE message is trivial. This is the critical
 * property: "done" alone is an acknowledgement, but "documents done" is
 * information. Matching a word inside a longer message would silently discard real
 * updates — exactly the failure mode the whole reply design was chosen to avoid.
 *
 * Filtered messages are still recorded in our own database (never sent to the CRM),
 * so the list below can be corrected against real usage rather than guessed at
 * twice.
 */

/**
 * Messages that carry no information when they are the whole message.
 * Compared after lowercasing and stripping punctuation and whitespace.
 */
const NOISE_PHRASES = new Set([
  'ok', 'okay', 'oky', 'k', 'kk', 'okk', 'ok done', 'okie',
  'done', 'did', 'completed',
  'thanks', 'thank you', 'thankyou', 'thx', 'ty', 'tq',
  'yes', 'yeah', 'yep', 'ya', 'yup', 'haan', 'ha', 'hn',
  'no', 'nope', 'nahi', 'na',
  'sure', 'noted', 'got it', 'gotit', 'understood', 'received',
  'hmm', 'hm', 'hmmm',
  'fine', 'great', 'good', 'nice', 'super', 'perfect', 'excellent',
  'welcome', 'wc', 'anytime',
  'hi', 'hello', 'hey', 'gm', 'good morning', 'good evening', 'good night',
  'checking', 'calling', 'will do', 'on it', 'sure sir', 'ok sir', 'yes sir',
  'ji', 'ji sir', 'theek hai', 'thik hai'
]);

/**
 * Strip emoji, variation selectors, zero-width joiners and skin-tone modifiers.
 * Used to decide whether anything but emoji remains.
 */
const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;

/**
 * Decide whether a message is noise.
 *
 * @param {string} text
 * @returns {{ isNoise: boolean, reason: string|null }}
 */
function classify(text) {
  if (text === null || text === undefined) {
    return { isNoise: true, reason: 'empty' };
  }

  const trimmed = String(text).trim();

  if (!trimmed) {
    return { isNoise: true, reason: 'empty' };
  }

  // Emoji-only, or emoji plus punctuation.
  const withoutEmoji = trimmed.replace(EMOJI_PATTERN, '').trim();
  if (!withoutEmoji) {
    return { isNoise: true, reason: 'emoji_only' };
  }

  // Punctuation-only, e.g. "..." or "??".
  if (!/[\p{L}\p{N}]/u.test(trimmed)) {
    return { isNoise: true, reason: 'punctuation_only' };
  }

  // Compare the whole message — never a substring.
  const normalised = withoutEmoji
    .toLowerCase()
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (NOISE_PHRASES.has(normalised)) {
    return { isNoise: true, reason: 'acknowledgement' };
  }

  return { isNoise: false, reason: null };
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isNoise(text) {
  return classify(text).isNoise;
}

module.exports = { classify, isNoise, NOISE_PHRASES };
