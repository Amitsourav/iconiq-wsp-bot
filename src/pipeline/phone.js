/**
 * Phone number extraction and normalisation.
 *
 * Deliberately mirrors the CRM's own `normalize_phone` (C14) so we can predict
 * whether a number will deduplicate before we send it. Their rules:
 *
 *   0091XXXXXXXXXX -> +91XXXXXXXXXX
 *   91XXXXXXXXXX   -> +91XXXXXXXXXX
 *   0XXXXXXXXXX    -> +91XXXXXXXXXX
 *   10 digits      -> +91XXXXXXXXXX
 *   anything else  -> stored verbatim
 *
 * That last case is why extraction matters as much as normalisation: anything we
 * pass through that isn't a clean Indian number gets stored raw and will never
 * dedupe against its normalised twin. So we only ever emit clean digits.
 */

/** Indian mobile numbers are 10 digits and begin 6–9. */
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Strip everything that isn't a digit or a leading plus.
 * @param {string} raw
 * @returns {string}
 */
function stripFormatting(raw) {
  return String(raw).trim().replace(/[\s\-().]/g, '');
}

/**
 * Whether a run of digits is claiming to be an Indian number.
 *
 * These shapes must satisfy the mobile rule or be rejected outright — falling
 * through to the international branch would let "+911234567890" (a landline, or
 * a typo) become a lead under a number nobody can call.
 */
function looksIndian(digits) {
  return /^0091\d{10}$/.test(digits) || /^91\d{10}$/.test(digits)
    || /^0\d{10}$/.test(digits) || /^\d{10}$/.test(digits);
}

/**
 * Normalise a phone number the same way the CRM will.
 *
 * Indian numbers resolve to +91XXXXXXXXXX, matching the CRM's own
 * `normalize_phone` so we can predict that they will deduplicate.
 *
 * Anything else is accepted ONLY when written with an explicit `+` and country
 * code, at an E.164 length of 8-15 digits. The `+` is the safety catch: a bare
 * eleven-digit run could be an account number, an Aadhaar fragment or two
 * numbers that ran together, and inventing a lead from one puts a record in the
 * CRM that nobody can act on. Someone writing +965… has stated a country.
 *
 * @param {string} raw
 * @returns {{ e164: string|null, national: string|null, normalised: boolean,
 *   international: boolean }}
 *   `normalised` is false when the number is unusable and the caller should skip
 *   it. `international` marks a number the CRM stores verbatim rather than
 *   normalising (C14) — it deduplicates against an identical string, but not
 *   against the same number written another way.
 */
function normalise(raw) {
  const miss = { e164: null, national: null, normalised: false, international: false };
  if (!raw) return miss;

  const stripped = stripFormatting(raw);
  const hadPlus = stripped.startsWith('+');
  const s = stripped.replace(/^\+/, '');

  if (looksIndian(s)) {
    let national = null;
    if (/^0091\d{10}$/.test(s)) national = s.slice(4);
    else if (/^91\d{10}$/.test(s)) national = s.slice(2);
    else if (/^0\d{10}$/.test(s)) national = s.slice(1);
    else national = s;

    if (!INDIAN_MOBILE.test(national)) return miss;
    return { e164: `+91${national}`, national, normalised: true, international: false };
  }

  // Overseas. FundMyCampus is a study-abroad business, so a student or parent
  // reachable on a foreign number is ordinary, not exceptional — this was
  // rejected outright until a Kuwait lead was silently dropped on 2 Sep 2026.
  if (hadPlus && /^\d{8,15}$/.test(s)) {
    return { e164: `+${s}`, national: null, normalised: true, international: true };
  }

  return miss;
}

/**
 * Find phone numbers in a block of text.
 *
 * Conservative on purpose. A WhatsApp lead message contains pincodes, loan amounts,
 * percentages and years, and treating any of those as a phone number would create a
 * junk lead — worse than missing one, because it lands in the CRM looking real.
 *
 * @param {string} text
 * @returns {string[]} unique E.164 numbers, in order of appearance
 */
function extract(text) {
  if (!text) return [];

  const found = [];
  const seen = new Set();

  // Match runs that could be a number with optional country code and separators.
  // Requires at least 10 digits so 6-digit pincodes and 4-digit years never match.
  //
  // Spaces and tabs are allowed inside a run but NOT newlines: with \s, two
  // numbers on consecutive lines merge into one over-long run, which is then
  // rejected as too long — losing both.
  const candidates = text.match(/\+?\d[\d \t\-().]{8,}\d/g) || [];

  for (const candidate of candidates) {
    const digits = stripFormatting(candidate).replace(/^\+/, '');

    // E.164 tops out at 15 digits. Longer than that is an account number, an ID,
    // or two numbers that ran together — never a phone number.
    if (digits.length > 15) continue;

    const { e164, normalised } = normalise(candidate);
    if (normalised && !seen.has(e164)) {
      seen.add(e164);
      found.push(e164);
    }
  }

  return found;
}

/**
 * Number-like runs in a message that could NOT be turned into a usable number.
 *
 * The point is to tell a lead that failed from ordinary chat. Most messages with
 * no usable phone are conversation — "apne apne cases update kro" — and replying
 * to those would make the bot an interruption. A message carrying something that
 * looks like a number is different: somebody was trying to share a lead, and
 * silence leaves them believing it worked.
 *
 * Mention placeholders are stripped first. WhatsApp renders a mention in the body
 * as "@192703069470725", a fifteen-digit LID that would otherwise read as a
 * mangled phone number and make the bot answer every tagged message in the group.
 *
 * @param {string} text
 * @returns {string[]} the raw runs, as written
 */
function findUnreadable(text) {
  if (!text) return [];

  const cleaned = String(text).replace(/@\d[\d \t-]{6,}/g, ' ');
  const found = [];

  for (const candidate of cleaned.match(/\+?\d[\d \t\-().]{8,}\d/g) || []) {
    if (normalise(candidate).normalised) continue;

    const digits = stripFormatting(candidate).replace(/^\+/, '');
    // Too short or too long to have been a phone number at all — a year range,
    // an amount, an account number. Not evidence of a failed lead.
    if (digits.length < 8 || digits.length > 15) continue;

    const raw = candidate.trim();
    if (!found.includes(raw)) found.push(raw);
  }

  return found;
}

/**
 * Convert a WhatsApp JID to a normalised number.
 * Mentions arrive as "919876543210@s.whatsapp.net".
 *
 * @param {string} jid
 * @returns {string|null} E.164, or null if it isn't a normalisable Indian number
 */
function fromJid(jid) {
  if (!jid) return null;
  const digits = String(jid).split('@')[0].split(':')[0];
  return normalise(digits).e164;
}

/**
 * Same as fromJid, but also accepts overseas numbers.
 *
 * A JID's digits are always a full international number by protocol — WhatsApp
 * just never puts a "+" in front of them — so plain fromJid() only ever
 * resolves the Indian shapes normalise() recognises without one (C14). For a DM
 * chat's identity, that's not good enough: a customer JID IS the phone number,
 * unlike free text where an unmarked run of digits could be almost anything, so
 * the "+" safety catch in normalise() doesn't apply here. Used only for DM
 * threads (pipeline/orchestrator.js handleDirect) — never for numbers pulled out
 * of message bodies, which must keep going through fromJid()/extract().
 *
 * @param {string} jid
 * @returns {string|null} E.164, or null if the digits don't look like a phone number
 */
function fromJidInternational(jid) {
  if (!jid) return null;
  const digits = String(jid).split('@')[0].split(':')[0];
  return normalise(digits).e164 || normalise(`+${digits}`).e164;
}

module.exports = {
  normalise, extract, fromJid, fromJidInternational, stripFormatting, findUnreadable
};
