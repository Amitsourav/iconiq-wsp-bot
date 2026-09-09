/**
 * Loan amount detection.
 *
 * The one field the bot infers without an explicit label, because money is written
 * with markers nothing else uses — "lakh", "cr", "₹", "Rs" — so recognising it does
 * not require guessing the way "Delhi University" would.
 *
 * Everything else still follows the labelled rule: text the bot cannot place goes
 * to remarks rather than into a column.
 *
 * The CRM stores loan_amount as free text (max 50), so the value is kept close to
 * how it was written — "7 Lakhs" reads better to a counsellor than 700000.
 */

/** A number, then an Indian magnitude word. "7 lakh", "1.5cr", "15L". */
const WITH_UNIT = /^(?:₹|rs\.?|inr)?\s*(\d+(?:[.,]\d+)?)\s*(lakhs?|lacs?|lkhs?|lakcs?|lc|l|crores?|crs?|cr|k|thousand)\b\.?$/i;

/** A currency marker with digits. "₹7,00,000", "Rs 700000". */
const WITH_CURRENCY = /^(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)$/i;

/** Indian digit grouping, which only ever means money. "7,00,000". */
const GROUPED = /^(\d{1,3}(?:,\d{2})+,\d{3})$/;

/** Normalised unit names, for a tidy stored value. */
const UNITS = {
  l: 'Lakh', lakh: 'Lakh', lakhs: 'Lakh', lac: 'Lakh', lacs: 'Lakh',
  lkh: 'Lakh', lkhs: 'Lakh', lakc: 'Lakh', lakcs: 'Lakh', lc: 'Lakh',
  cr: 'Cr', crore: 'Cr', crores: 'Cr', crs: 'Cr',
  k: 'K', thousand: 'K'
};

/**
 * Decide whether a piece of text is a money amount.
 *
 * Deliberately strict: a bare number like "700000" is NOT treated as an amount,
 * because it could be anything. A marker must be present.
 *
 * @param {string} text
 * @returns {{ isAmount: boolean, value: string|null }} `value` is the tidied form
 *   to store, or null when the text is not an amount.
 */
function detect(text) {
  const { cleanLine } = require('./clean');
  const trimmed = cleanLine(text).replace(/[.,;]+$/, '');
  if (!trimmed || trimmed.length > 30) return { isAmount: false, value: null };

  const unit = trimmed.match(WITH_UNIT);
  if (unit) {
    const [, number, rawUnit] = unit;
    const clean = number.replace(/,/g, '');
    // "15L" and "15 lakhs" should store identically.
    return { isAmount: true, value: `${trimNumber(clean)} ${UNITS[rawUnit.toLowerCase()]}` };
  }

  const currency = trimmed.match(WITH_CURRENCY);
  if (currency) {
    return { isAmount: true, value: `₹${currency[1]}` };
  }

  const grouped = trimmed.match(GROUPED);
  if (grouped) {
    return { isAmount: true, value: `₹${grouped[1]}` };
  }

  return { isAmount: false, value: null };
}

/** Drop a trailing ".0" so "7.0 Lakh" stores as "7 Lakh". */
function trimNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : value;
}

/**
 * Find an amount among the lines of a message.
 *
 * Only a line that is entirely an amount counts. "7 Lakhs" on its own line is the
 * loan amount; "needs about 7 lakhs if possible" is a sentence, and belongs in
 * remarks where a human will read it in context.
 *
 * @param {string} text
 * @returns {string|null}
 */
function findInLines(text) {
  const found = [];
  for (const line of String(text || '').split('\n')) {
    const { isAmount, value } = detect(line);
    if (isAmount && !found.includes(value)) found.push(value);
  }

  // One figure is unambiguous. Several are not: a message listing 52 lakh and
  // 60 lakh has no single "the amount", and picking the first would understate
  // the file by half. The caller asks instead.
  if (found.length === 1) return found[0];
  return null;
}

/**
 * Every distinct amount in a message, for reporting an ambiguity.
 * @param {string} text
 * @returns {string[]}
 */
function findAll(text) {
  const found = [];
  for (const line of String(text || '').split('\n')) {
    const { isAmount, value } = detect(line);
    if (isAmount && !found.includes(value)) found.push(value);
  }
  return found;
}

module.exports = { detect, findInLines, findAll };
