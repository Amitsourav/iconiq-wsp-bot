/**
 * Minimal OpenRouter chat-completions client.
 *
 * Node 22 has a global `fetch`, so no HTTP dependency is needed.
 */
const { config } = require('../config');
const logger = require('../logger');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 30_000;

/**
 * @param {{role: 'system'|'user'|'assistant', content: string}[]} messages
 * @returns {Promise<string|null>} the assistant's reply text, or null on failure
 */
async function chat(messages) {
  if (!config.ai.openrouterApiKey) {
    logger.error('OPENROUTER_API_KEY is not set — cannot generate an AI reply.');
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.openrouterApiKey}`,
        // Optional attribution headers OpenRouter uses for its own leaderboards.
        ...(config.ai.siteUrl ? { 'HTTP-Referer': config.ai.siteUrl } : {}),
        ...(config.ai.siteName ? { 'X-Title': config.ai.siteName } : {})
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages,
        temperature: 0.6,
        max_tokens: 500
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text.trim() : null;
  } catch (error) {
    logger.error(`OpenRouter request failed: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { chat };
