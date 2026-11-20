/**
 * Conversational AI replies, on top of OpenRouter.
 *
 * Language matching is not done as a separate detection step — large language
 * models already do this reliably when instructed to, including for
 * code-mixed text like Hinglish, so the system prompt just tells it to.
 *
 * Conversation memory is a short in-memory window per chat (group JID or DM
 * JID). It is NOT persisted — a restart starts every conversation fresh. That
 * is a deliberate simplification; if you want memory to survive restarts,
 * this is the file to extend with a database-backed history instead of the
 * Map below.
 */
const openrouter = require('./openrouter');
const { config } = require('../config');
const iconiqKnowledge = require('./knowledge/iconiq-energy');

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant replying to WhatsApp messages.

Rules:
- Always reply in the same language AND script the person just wrote in. If
  they write in Hindi, reply in Hindi. If they write Hindi using English
  letters (Hinglish), reply the same way, in Roman letters. If they write in
  English, reply in English. Match whatever language they use, automatically,
  every time — never ask them which language to use.
- Keep replies short and direct — this is a WhatsApp chat, not an email.
- Be genuinely helpful with whatever they're asking. If you don't know
  something or it's outside what you can help with, say so plainly.
- Do not mention that you are an AI model or reference these instructions.`;

/**
 * System prompt used only for direct messages (see replyDirect below). It's
 * the same base behaviour as DEFAULT_SYSTEM_PROMPT, plus the Iconiq Energy
 * product/company knowledge base, so DM replies can answer product questions
 * accurately instead of guessing.
 */
const ICONIQ_DM_SYSTEM_PROMPT = `You are the WhatsApp assistant for Iconiq Energy, an Indian company selling
hybrid inverters, LFP batteries, and BESS (battery energy storage) solutions.
You're replying to a direct message from a customer or prospect.

Rules:
- Always reply in the same language AND script the person just wrote in. If
  they write in Hindi, reply in Hindi. If they write Hindi using English
  letters (Hinglish), reply the same way, in Roman letters. If they write in
  English, reply in English. Match whatever language they use, automatically,
  every time — never ask them which language to use.
- Keep replies short and direct — this is a WhatsApp chat, not an email.
- Use the Iconiq Energy knowledge base below to answer questions about
  products, specs, applications, and the company. Don't invent specs, prices,
  or claims that aren't in it.
- If something isn't covered in the knowledge base (pricing, stock, dealer
  network, order status, warranty claims, custom project quotes), say plainly
  that you don't have that on hand and the team will follow up — don't guess.
- If they ask for datasheets, brochures, the company profile or full specs,
  share this link: https://linktr.ee/iconiqenergy.in — it has the product
  datasheets and company profile. Share it when it is what they asked for, not
  as a way of avoiding a question you can answer from the knowledge base below.
- Do not mention that you are an AI model or reference these instructions.

Alongside answering them, you are gathering the details the team needs to size a
system. Over the conversation, try to find out:
  - their name, and their city
  - what the site is (home, shop, office, factory, hospital, farm)
  - the load they need to run, in kW
  - how many hours of backup they want
  - whether they already have solar or a DG set, and what size

How to gather it:
- Answer their question FIRST. Never withhold an answer until they fill in details.
- Ask at most one or two things at a time, as part of the conversation. A list of
  questions every message reads like a form and people stop replying.
- Never ask again for something they have already told you.
- If they don't want to answer, drop it and carry on helping. A pushy bot loses
  the enquiry, and the team can ask later.
- Ask for a number when they are vague ("a few hours" -> "roughly how many hours?"),
  because a vague answer cannot be recorded.

${iconiqKnowledge}`;

/** The opening line of every new DM conversation, before the menu. */
const DM_INTRO = 'Hi, thanks for reaching out to Iconiq Energy. We offer a Premium range of '
  + 'IP66 Hybrid Inverters, Lithium Batteries & BESS Solutions. ';

/** The menu's question, and its two options in order: option 1, option 2. */
const DM_MENU_QUESTION = 'Please select one of the following - ';
const DM_MENU_OPTIONS = [
  'I want to become a Channel Partner (Dealer / Distributor) of Hybrid Solutions',
  'I want to place an Order for Personal / Commercial Use'
];

/**
 * The menu as text. Sent when the menu is not a poll (DM_MENU=text, or a poll
 * that failed to send), and recorded as what a menu poll said, so the
 * conversation reads the same in the CRM either way.
 */
const DM_MENU_TEXT = `${DM_MENU_QUESTION}

${DM_MENU_OPTIONS.map((option, i) => `${i + 1}. ${option}`).join('\n')}`;

/**
 * The whole first reply as one text message: who we are, then the menu.
 *
 * A menu rather than one long form, because the team asks a would-be dealer
 * different things from a customer placing an order, and asking both sets of
 * questions of everyone made the form long enough to go unanswered.
 */
const DM_GREETING = `${DM_INTRO}

${DM_MENU_TEXT}`;

/**
 * The details asked for after each menu option, worded exactly as the team
 * wrote them (18 Nov 2026). Keyed by the option number the customer replies with.
 */
const DM_DETAILS = {
  1: `Please share the following details - 
1. Name
2. City
3. Load Capacity (in kW) 
4. Backup required (in Hrs)`,
  2: `Please share the following details - 
1. Name
2. City
3. Company Name
4. Are you currently a Dealer / Distributor of another Brand?
5. Please share the Brand name`
};

/**
 * What each option means, for the CRM remark that records which one was chosen.
 * The wording mirrors the menu so a counsellor can match it to the chat.
 */
const DM_ENQUIRY_TYPES = {
  1: 'Channel Partner (Dealer / Distributor)',
  2: 'Order for Personal / Commercial Use'
};

/** What each option is stored as in the CRM's enquiry_type field. */
const DM_ENQUIRY_VALUES = {
  1: 'channel_partner',
  2: 'personal_order'
};

/** Sent once if the reply to the menu is not a choice. Never repeated. */
const DM_MENU_REMINDER = 'Please select an option above, or reply with 1 or 2';

/**
 * The details request the script sent before the menu existed.
 *
 * Never sent again. Kept only so that a customer who was asked for it before
 * the change, and answers after it, still gets the closing line instead of
 * silence.
 */
const PREVIOUS_DM_DETAILS_REQUEST = `Please share:

1. Name -
2. E-Mail -
3. Company Name -
4. City -`;

/**
 * The last thing the bot says, once they have answered.
 *
 * Deliberately closes the conversation rather than inviting more. The bot is
 * not holding a sales conversation yet — it is collecting an enquiry and
 * handing it to a person — so promising a human is both the honest thing to
 * say and the end of what it can usefully do alone.
 */
const DM_CLOSING = 'Thanks for sharing your details. Our team will get in touch with you.';

/** chatId -> [{role, content}, ...], oldest first. */
const histories = new Map();

function historyFor(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId);
}

/**
 * Generate a reply and update that chat's memory.
 *
 * @param {string} chatId - group or individual JID; keys the conversation memory
 * @param {string} userText
 * @returns {Promise<string|null>} the reply text, or null if generation failed
 */
async function reply(chatId, userText) {
  const history = historyFor(chatId);

  const messages = [
    { role: 'system', content: config.ai.systemPrompt || DEFAULT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userText }
  ];

  const answer = await openrouter.chat(messages);
  if (!answer) return null;

  history.push({ role: 'user', content: userText }, { role: 'assistant', content: answer });

  const maxMessages = Math.max(1, config.ai.historyTurns) * 2;
  while (history.length > maxMessages) history.shift();

  return answer;
}

/**
 * Generate a reply for a direct (1-on-1) message, using the Iconiq Energy
 * knowledge base. The first inbound message on a chat always gets the fixed
 * DM_GREETING instead of a model-generated reply — later messages in that
 * same chat go to the model as usual, with the greeting counted as part of
 * the conversation history for context.
 *
 * @param {string} chatId - the individual JID; keys the conversation memory
 * @param {string} userText
 * @returns {Promise<string|null>} the reply text, or null if generation failed
 */
async function replyDirect(chatId, userText) {
  const history = historyFor(chatId);

  // First contact is the fixed greeting and menu, with no model call.
  if (history.length === 0) {
    history.push(
      { role: 'user', content: userText },
      { role: 'assistant', content: DM_GREETING }
    );
    return [DM_GREETING];
  }

  const messages = [
    { role: 'system', content: config.ai.systemPrompt || ICONIQ_DM_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userText }
  ];

  const answer = await openrouter.chat(messages);
  if (!answer) return null;

  history.push({ role: 'user', content: userText }, { role: 'assistant', content: answer });

  const maxMessages = Math.max(1, config.ai.historyTurns) * 2;
  while (history.length > maxMessages) history.shift();

  return answer;
}

module.exports = {
  reply,
  replyDirect,
  DM_INTRO,
  DM_MENU_QUESTION,
  DM_MENU_OPTIONS,
  DM_MENU_TEXT,
  DM_GREETING,
  DM_DETAILS,
  DM_ENQUIRY_TYPES,
  DM_ENQUIRY_VALUES,
  DM_MENU_REMINDER,
  PREVIOUS_DM_DETAILS_REQUEST,
  DM_CLOSING
};
