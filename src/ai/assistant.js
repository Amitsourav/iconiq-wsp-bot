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
- Do not mention that you are an AI model or reference these instructions.

${iconiqKnowledge}`;

/**
 * Fixed opening message sent as the very first reply in a new DM
 * conversation, before any AI-generated response. Kept as a literal string
 * (not model-generated) so every new conversation starts identically.
 */
const DM_GREETING = `Hi, thanks for reaching out to Iconiq Energy. We have a complete range of IP66 Hybrid Inverters (3-30 kW), LFP Batteries (5.12 kWh to 161 kWh) & BESS solutions.

Please share the following details so we can help you better.`;

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

  if (history.length === 0) {
    history.push({ role: 'user', content: userText }, { role: 'assistant', content: DM_GREETING });
    return DM_GREETING;
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

module.exports = { reply, replyDirect };
