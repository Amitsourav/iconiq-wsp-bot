/**
 * Pull structured lead details out of a DM conversation.
 *
 * The rest of this codebase writes a CRM field only from an explicit label
 * (R9) — "Load: 10" sets a field, prose never does. That rule exists because a
 * wrong value corrupts a record silently, and nobody notices until it is used in
 * front of a customer.
 *
 * A DM chatbot cannot work that way. Customers write "i need 10kw for my factory,
 * 4 hour backup" and will not be taught otherwise, because unlike the in-house
 * group they are not our staff (R10). So extraction here is done by the model —
 * but the rule is preserved rather than abandoned, in three ways:
 *
 *   1. The model is told to fill a field ONLY when the customer stated it
 *      outright, and to leave everything else out. It is not asked to interpret.
 *   2. Every value it returns is then put through `coerce()` — the SAME
 *      validator a typed label goes through. The model cannot write anything a
 *      person typing a label could not write.
 *   3. Anything rejected is simply not written. It stays in the transcript,
 *      which reaches the CRM as a remark either way, so nothing is ever lost by
 *      refusing it.
 *
 * The result is that a bad extraction costs an empty field, never a wrong one.
 */
const openrouter = require('./openrouter');
const { coerce } = require('../pipeline/labels');
const logger = require('../logger');

/**
 * The fields worth asking a solar/BESS enquiry for, and how to describe each one
 * to the model. Keys are CRM field names, so nothing has to be translated later.
 */
const EXTRACTABLE = {
  full_name: 'the person\'s own name, if they give it',
  email: 'their email address',
  city: 'the city or town where the site is',
  organization: 'their company or business name',
  application_industry: 'what the site is (factory, hospital, school, home, shop, office, farm)',
  load_capacity_kw: 'the load they need to run, in kW, as a number only',
  backup_duration_hours: 'how many hours of backup they want, as a number only',
  solar_present: 'true only if they say they ALREADY have solar, false only if they say they do not',
  solar_capacity_kw: 'the size of their EXISTING solar in kW, as a number only',
  dg_available: 'true only if they say they have a diesel generator, false only if they say they do not',
  dg_capacity_kva: 'the size of their existing DG in kVA, as a number only'
};

const SYSTEM_PROMPT = `You read a WhatsApp conversation between a customer and Iconiq Energy (solar, hybrid inverters, batteries, BESS) and pull out only the facts the customer actually stated.

Return ONLY a JSON object. No explanation, no markdown, no code fence.

Fields you may return (leave a field OUT entirely if the customer did not state it):
${Object.entries(EXTRACTABLE).map(([k, v]) => `- "${k}": ${v}`).join('\n')}

Absolute rules:
- Only include a field if the CUSTOMER stated it plainly. Never infer, never assume, never guess.
- If they were vague ("a big load", "few hours", "maybe solar"), leave the field out. Vague is not a value.
- Never take a number the BOT said and treat it as the customer's requirement. Product sizes the bot mentioned are not the customer's answer.
- "I want solar" is a request, NOT solar_present. solar_present is true only if they already HAVE solar installed.
- Never invent a name. If they did not say their name, leave full_name out.
- Numbers must be plain numbers: 10, not "10kW".
- If the customer stated nothing concrete, return {}.`;

/** Strip a code fence if the model wrapped its JSON in one anyway. */
function stripFence(text) {
  return String(text).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/**
 * Read a conversation and return the fields the customer stated.
 *
 * Never throws: extraction is an enhancement, and a failure here must not cost
 * the reply or the lead. A failed extraction returns nothing, and the next
 * message tries again over the same history.
 *
 * @param {{role: string, content: string}[]} history - the conversation so far
 * @returns {Promise<{ fields: Object, refused: {field: string, value: *, reason: string}[] }>}
 */
async function extractFields(history) {
  const transcript = history
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
    .join('\n');

  if (!transcript.trim()) return { fields: {}, refused: [] };

  const answer = await openrouter.chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: transcript }
  ]);

  if (!answer) return { fields: {}, refused: [] };

  let raw;
  try {
    raw = JSON.parse(stripFence(answer));
  } catch {
    // A model that did not return JSON is a failed extraction, not a crash.
    logger.warn(`Lead extraction returned non-JSON: ${String(answer).slice(0, 120)}`);
    return { fields: {}, refused: [] };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { fields: {}, refused: [] };
  }

  const fields = {};
  const refused = [];

  for (const [field, value] of Object.entries(raw)) {
    // A field nobody asked for is not written, whatever the model returns.
    if (!(field in EXTRACTABLE)) {
      refused.push({ field, value, reason: 'not_extractable' });
      continue;
    }
    if (value === null || value === undefined || value === '') continue;

    // The same gate a typed label goes through. A number that will not parse, a
    // boolean that is not a clear yes or no, a date that makes no sense — all
    // refused here exactly as they would be if someone had typed them.
    const result = coerce(field, String(value));
    if (!result.ok) {
      refused.push({ field, value, reason: result.reason });
      continue;
    }

    fields[field] = result.value;
  }

  if (refused.length) {
    logger.warn(`Lead extraction refused ${refused.length} value(s): `
      + refused.map((r) => `${r.field}=${JSON.stringify(r.value)} (${r.reason})`).join(', '));
  }

  return { fields, refused };
}

module.exports = { extractFields, EXTRACTABLE, SYSTEM_PROMPT };
