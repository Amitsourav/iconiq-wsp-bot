/**
 * Labelled-field parsing (R9, R11.2–R11.5).
 *
 * Turns "University: Delhi University" into { university: 'Delhi University' }.
 *
 * The governing rule is that a structured CRM field is ONLY ever written from an
 * explicit label. Nothing here infers that "she needs 15 lakh" means loan_amount —
 * a wrong guess corrupts a record silently, and silent corruption is worse than a
 * missed update. Anything not confidently understood is returned as remark text.
 */
const {
  resolveLabel, ARRAY_FIELDS, NUMERIC_FIELDS, LABEL_FORBIDDEN,
  MAX_LENGTH, LOCKED_LISTS
} = require('../crm/fields');
const amount = require('./amount');
const { cleanLine, cleanText } = require('./clean');

/** `:` `-` and `=` are all accepted (R11.3). */
const LABELLED_LINE = /^\s*([A-Za-z%][A-Za-z\s%]{0,29}?)\s*[:=\-–—]\s*(.+?)\s*$/;

/**
 * Match a value against a locked list, case-insensitively (M6).
 * @param {string} field
 * @param {string} value
 * @returns {string|null} the exact list entry, or null if there is no match
 */
function matchLockedList(field, value) {
  const list = LOCKED_LISTS[field];
  if (!list) return value;

  const needle = value.trim().toLowerCase();
  return list.find((entry) => entry.toLowerCase() === needle) || null;
}

/**
 * Coerce a raw string into the shape the CRM field expects.
 *
 * @param {string} field
 * @param {string} raw
 * @returns {{ ok: boolean, value: * , reason?: string }}
 */
function coerce(field, raw) {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'empty_value' };

  if (ARRAY_FIELDS.has(field)) {
    const items = value.split(/[,/]|\band\b/i).map((v) => v.trim()).filter(Boolean);
    return items.length ? { ok: true, value: items } : { ok: false, reason: 'empty_value' };
  }

  if (NUMERIC_FIELDS.has(field)) {
    const num = Number(value.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(num)) return { ok: false, reason: 'not_a_number' };
    if (field === 'percentage' && (num < 0 || num > 999.99)) {
      return { ok: false, reason: 'out_of_range' };
    }
    if (field === 'passing_year' && (num < 1950 || num > 2100)) {
      return { ok: false, reason: 'out_of_range' };
    }
    return { ok: true, value: num };
  }

  if (field === 'date_of_birth') {
    const iso = toIsoDate(value);
    return iso ? { ok: true, value: iso } : { ok: false, reason: 'unparsable_date' };
  }

  if (LOCKED_LISTS[field]) {
    const matched = matchLockedList(field, value);
    // No exact match means we do not guess — the text goes to remarks instead.
    return matched
      ? { ok: true, value: matched }
      : { ok: false, reason: 'not_in_locked_list' };
  }

  const max = MAX_LENGTH[field];
  return { ok: true, value: max ? value.slice(0, max) : value };
}

/**
 * Convert common Indian date formats to YYYY-MM-DD.
 * @param {string} value
 * @returns {string|null}
 */
function toIsoDate(value) {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return value;

  const dmy = value.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    let [, d, m, y] = dmy;
    if (y.length === 2) y = Number(y) > 30 ? `19${y}` : `20${y}`;
    const day = Number(d);
    const month = Number(m);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  return null;
}

/**
 * Parse a message into structured field updates and leftover text.
 *
 * @param {string} text
 * @returns {{
 *   fields: Object<string, *>,
 *   updateOnly: string[],
 *   rejected: {label: string, value: string, reason: string}[],
 *   plain: string[]
 * }}
 *   `fields`   — validated updates, safe to send
 *   `rejected` — labelled lines we deliberately refused (unknown label, value not
 *                in a locked list, unparsable). These go to remarks (R11.5) so the
 *                information survives even though no field matched.
 *   `plain`    — lines with no label at all. Also remark material.
 */
function parse(text) {
  const result = { fields: {}, updateOnly: [], rejected: [], plain: [] };
  if (!text) return result;

  // Decided up front, because it is a property of the whole message: a single
  // figure is the amount, several figures are a breakdown with no single answer.
  const bareAmounts = amount.findAll(cleanText(text));
  const amountIsUnambiguous = bareAmounts.length === 1;

  for (const raw of String(text).split('\n')) {
    // Bullets and invisible joiners would otherwise defeat every rule below and
    // end up inside the values we store.
    const trimmed = cleanLine(raw);
    if (!trimmed) continue;

    const match = trimmed.match(LABELLED_LINE);
    if (!match) {
      // A line that is entirely a money amount fills loan_amount without needing
      // a label — but only when the message contains exactly one. A file written
      // as "tuition 52 lakh / living 60 lakh / total 1.1 Cr" has no single figure
      // to take, and picking the first would understate it by half.
      const money = amount.detect(trimmed);
      if (money.isAmount) {
        if (amountIsUnambiguous && !result.fields.loan_amount) {
          result.fields.loan_amount = money.value;
          continue;
        }
        // Ambiguous: keep it as text so the figure is not lost.
        result.plain.push(trimmed);
        continue;
      }
      result.plain.push(trimmed);
      continue;
    }

    const [, rawLabel, rawValue] = match;
    const field = resolveLabel(rawLabel);

    if (!field) {
      // R11.5 — an unrecognised label is never dropped.
      result.rejected.push({
        label: rawLabel.trim(),
        value: rawValue.trim(),
        reason: 'unknown_label'
      });
      continue;
    }

    if (LABEL_FORBIDDEN.has(field)) {
      result.rejected.push({
        label: rawLabel.trim(),
        value: rawValue.trim(),
        reason: 'field_not_writable'
      });
      continue;
    }

    const coerced = coerce(field, rawValue);
    if (!coerced.ok) {
      result.rejected.push({
        label: rawLabel.trim(),
        value: rawValue.trim(),
        reason: coerced.reason
      });
      continue;
    }

    result.fields[field] = coerced.value;
  }

  return result;
}

/**
 * Every figure in a message that could be the loan amount.
 *
 * Looks at bare lines AND the values of labels we could not place — "Tution - 52
 * Lakhs" carries a figure even though "Tution" is not a field, and a message with
 * two such lines is exactly the ambiguous case worth asking about.
 *
 * @param {string} text
 * @param {{label: string, value: string}[]} [rejected] - from parse()
 * @returns {string[]} distinct amounts, as they would be stored
 */
function amountCandidates(text, rejected = []) {
  const found = amount.findAll(text);

  for (const item of rejected) {
    const money = amount.detect(item.value);
    if (money.isAmount && !found.includes(money.value)) found.push(money.value);
  }

  return found;
}

module.exports = { parse, coerce, toIsoDate, matchLockedList, amountCandidates };
