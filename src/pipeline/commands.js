/**
 * Commands the bot answers in the group.
 *
 * The governing rule is the same one the noise filter uses: **the whole message
 * must be the command**. "my leads" is a command; "let me check my leads later"
 * is conversation, and answering it would make the bot an interruption rather
 * than a tool.
 *
 * Deliberately a short, closed list. Every command added is another chance to
 * misfire on something someone genuinely said.
 */

/** command name → the exact phrases that invoke it. */
const COMMANDS = {
  myLeads: [
    'my leads', 'my lead', 'myleads', 'my leads?', 'leads?', 'my list',
    'mere leads', 'my pending', 'my open leads'
  ],
  help: ['help', 'bot help', 'commands', 'what can you do']
};

/**
 * Words that mean "move this lead", when replying to one.
 *
 * An explicit word is required — a bare tag would be far too easy to trigger by
 * accident, since people tag each other constantly in conversation. This is the
 * single guard that makes reassignment safe.
 */
const REASSIGN_WORDS = /^\s*(assign|reassign|transfer|move|handover|hand over|give)\b/i;

/**
 * Identify a reassignment instruction on a reply.
 *
 * @param {string} text
 * @param {string[]} mentions - resolved phone numbers
 * @returns {{ to: string }|{ error: string }|null}
 */
function parseReassign(text, mentions = []) {
  if (!text || !REASSIGN_WORDS.test(text)) return null;

  // Length alone is not enough: "move to Canada next year is what he wants" is
  // short and opens with a command word. What separates an instruction from a
  // sentence is that almost nothing is left once the command word and the tag
  // are removed.
  const remainder = String(text)
    .replace(REASSIGN_WORDS, '')
    .replace(/@\d[\d \t-]{6,}/g, ' ')
    .replace(/\b(to|this|it|lead|please|pls|now)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();

  if (remainder.split(/\s+/).filter(Boolean).length > 2) return null;

  if (mentions.length === 0) return { error: 'no_mention' };
  if (mentions.length > 1) return { error: 'multiple_mentions' };

  return { to: mentions[0] };
}

/**
 * Identify a command.
 *
 * @param {string} text
 * @returns {{ name: string }|null}
 */
function parse(text) {
  if (!text) return null;

  const normalised = String(text)
    .trim()
    .toLowerCase()
    .replace(/[.!,;:]+$/g, '')
    .replace(/\s+/g, ' ');

  // A long message is conversation, whatever it contains.
  if (normalised.length > 24) return null;

  for (const [name, phrases] of Object.entries(COMMANDS)) {
    if (phrases.includes(normalised)) return { name };
  }

  return null;
}

/** What the bot can be asked. Kept short — it is read in a busy group. */
const HELP_TEXT = [
  'What I do:',
  '',
  '• Post a number and tag someone → I create the lead in the CRM',
  '• Post a number with no tag → I tell you who already has it',
  '• Reply to a lead → I add the details to it',
  '• Type "my leads" → I list yours',
  '• Reply "assign @name" on a lead → I move it to them',
  '',
  'For a field, write it plainly: University: Bharath Chennai'
].join('\n');

module.exports = { parse, parseReassign, COMMANDS, HELP_TEXT, REASSIGN_WORDS };
