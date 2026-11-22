/**
 * Which kind of enquiry a direct chat is — Channel Partner (B2B) or an order
 * for their own use (B2C) — and, for a partner, what kind of partner.
 *
 * Since 22 Nov 2026 customers are answered by Meta's Business AI rather than
 * the bot's own script, so there is no poll tap to read the choice from. Meta
 * AI follows the same script, though: a 1/2 menu, then a details request that
 * differs by option. So the choice is read, in order of certainty, from:
 *
 *   1. the bot's own details request, when the bot ran the script itself;
 *   2. which details request the business side sent — "our dealer program …
 *      Company Name … EPC partner or a Distributor" is the partner form,
 *      "place an order … Load Capacity … Backup" is the order form;
 *   3. the customer's reply to the menu, when it is the whole message and one
 *      of a few fixed words ("1", "dealer", "order").
 *
 * All three are closed vocabularies, so a value set here is as safe as a typed
 * label. Anything else is left for the AI's guess, which is marked as one in
 * the CRM (see extract.js and the orchestrator).
 *
 * Meta AI writes its own wording each time, so the markers are the phrases
 * that carry the meaning, not whole messages.
 */

/** A message offering both options: the menu itself, which says nothing about the choice. */
function isMenu(body) {
  const text = String(body || '').toLowerCase();
  return /\b(reply|respond|choose|select)\b[^.]*\b1\b[^.]*\b2\b/.test(text)
    || (/dealer|channel partner/.test(text) && /place an order|personal|commercial use/.test(text));
}

const PARTNER_MARKERS = [
  /dealer program/, /partner program/, /company name/, /epc partner/,
  /partner or a distributor/, /which brands?/, /brands? do you (work|deal)/
];
const ORDER_MARKERS = [
  /place an order/, /load capacity/, /backup (required|duration|hours|in hrs)/, /in kw\b/
];

/**
 * The option a business-side message asks the details for, or null.
 * @param {string} body
 * @returns {1|2|null}
 */
function fromBusinessMessage(body) {
  if (!body || isMenu(body)) return null;
  const text = body.toLowerCase();
  const partner = PARTNER_MARKERS.some((re) => re.test(text));
  const order = ORDER_MARKERS.some((re) => re.test(text));
  if (partner && !order) return 1;
  if (order && !partner) return 2;
  return null;
}

/**
 * The option a customer's reply to the menu picks, when the whole message is
 * one of a few fixed answers. "I want 1 inverter" is not an answer.
 * @param {string} text
 * @returns {1|2|null}
 */
function fromMenuReply(text) {
  const reply = String(text || '').toLowerCase().replace(/[*_~.!)]/g, '').replace(/\s+/g, ' ').trim();
  if (/^(option )?1(️?⃣)?$/.test(reply)) return 1;
  if (/^(option )?2(️?⃣)?$/.test(reply)) return 2;
  if (/^(i am a |i'm a |i want to become a |become a )?(dealer|distributor|dealership|channel partner|partner|epc|epc partner)$/.test(reply)) return 1;
  if (/^(i want to )?(place an )?(order|buy|purchase|personal|personal use|own use|commercial use)$/.test(reply)) return 2;
  return null;
}

/**
 * Read the enquiry type out of a conversation.
 *
 * @param {{ direction: 'in'|'out', body: string, author?: string|null }[]} rows - oldest first
 * @param {{ scriptDetails?: Object<string, string> }} [options] - the bot's own
 *   details requests by option, when it ran the script itself
 * @returns {{ option: 1|2, source: 'script'|'business'|'reply' }|null}
 */
function classify(rows, { scriptDetails = {} } = {}) {
  for (const row of rows) {
    if (row.direction !== 'out') continue;
    for (const [option, body] of Object.entries(scriptDetails)) {
      if (row.body === body) return { option: Number(option), source: 'script' };
    }
  }

  // Only what Meta AI (or the team) wrote. The bot's own older messages asked
  // for load and backup too, and are not a choice anyone made.
  for (const row of rows) {
    if (row.direction !== 'out' || row.author !== 'business') continue;
    const option = fromBusinessMessage(row.body);
    if (option) return { option, source: 'business' };
  }

  for (let i = 1; i < rows.length; i++) {
    if (rows[i].direction !== 'in') continue;
    const previousOut = rows.slice(0, i).reverse().find((r) => r.direction === 'out');
    if (!previousOut || !isMenu(previousOut.body)) continue;
    const option = fromMenuReply(rows[i].body);
    if (option) return { option, source: 'reply' };
  }

  return null;
}

/** Labels for the partner types, as the CRM shows them. */
const PARTNER_TYPES = { epc: 'EPC partner', distributor: 'Distributor', dealer: 'Dealer' };

/**
 * The partner type the customer gave, answering "Are you an EPC partner or a
 * Distributor?" — only from what they wrote after that question, only when
 * exactly one type is named, and never when it is negated ("not a dealer").
 *
 * @param {{ direction: 'in'|'out', body: string }[]} rows - oldest first
 * @returns {'epc'|'distributor'|'dealer'|null}
 */
function partnerType(rows) {
  const asked = rows.findIndex((r) => r.direction === 'out'
    && /epc partner|partner or a distributor|epc or (a )?distributor/i.test(r.body || ''));
  if (asked < 0) return null;

  for (const row of rows.slice(asked + 1)) {
    if (row.direction !== 'in') continue;
    const text = ` ${String(row.body || '').toLowerCase()} `;
    const named = [];
    if (mentions(text, 'epc')) named.push('epc');
    if (mentions(text, 'distributors?')) named.push('distributor');
    if (mentions(text, 'dealers?|retailers?|dealership')) named.push('dealer');
    if (named.length === 1) return named[0];
    if (named.length > 1) return null;
  }
  return null;
}

/** A whole-word mention that is not negated just before it. */
function mentions(text, word) {
  const re = new RegExp(`(^|[^a-z])(not|no|never|isn't|am not|aren't)?\\s*(an?\\s+)?(${word})([^a-z]|$)`, 'g');
  let match;
  let found = false;
  while ((match = re.exec(text))) {
    if (match[2]) return false; // "not a distributor" — say nothing rather than guess
    found = true;
  }
  return found;
}

module.exports = { classify, fromBusinessMessage, fromMenuReply, isMenu, partnerType, PARTNER_TYPES };
