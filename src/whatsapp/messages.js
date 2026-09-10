/**
 * Pull the parts we care about out of a Baileys message.
 *
 * Kept pure and separate from the socket so it can be tested against captured
 * message shapes without a WhatsApp connection.
 */
const phone = require('../pipeline/phone');
const { config } = require('../config');

/**
 * Extract the text body from any message type that carries one.
 * @param {object} message - the `message` object from a Baileys message
 * @returns {string|null}
 */
function textOf(message) {
  if (!message) return null;

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.ephemeralMessage?.message?.conversation ||
    message.ephemeralMessage?.message?.extendedTextMessage?.text ||
    message.viewOnceMessage?.message?.conversation ||
    message.viewOnceMessageV2?.message?.extendedTextMessage?.text ||
    null
  );
}

/** Unwrap the layers WhatsApp uses for disappearing and view-once messages. */
function unwrap(message) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message
  );
}

/**
 * The context block carries mentions and the quoted-message reference.
 */
function contextOf(message) {
  const inner = unwrap(message);
  return (
    inner?.extendedTextMessage?.contextInfo ||
    inner?.imageMessage?.contextInfo ||
    inner?.videoMessage?.contextInfo ||
    inner?.documentMessage?.contextInfo ||
    null
  );
}

/**
 * Normalise a Baileys message into the shape the pipeline works with.
 *
 * @param {object} raw - a message from the `messages.upsert` event
 * @returns {{
 *   id: string, groupId: string|null, isGroup: boolean, fromMe: boolean,
 *   senderPhone: string|null, text: string|null,
 *   mentions: string[], quotedId: string|null, timestamp: number
 * }|null}
 */
function normalise(raw) {
  if (!raw?.key?.id) return null;

  const remoteJid = raw.key.remoteJid || '';
  const isGroup = remoteJid.endsWith('@g.us');

  // In a group the actual sender is `participant`; remoteJid is the group.
  //
  // Both may be LIDs rather than phone numbers. When they are, WhatsApp sends
  // the real number alongside on the key — `participantPn` in a group,
  // `senderPn` in a direct chat — so prefer those. Without this a DM's LID gets
  // read as a foreign phone number and the lead is filed under a number that
  // does not exist.
  const senderPnJid = (isGroup ? raw.key.participantPn : raw.key.senderPn) || null;
  const senderJid = senderPnJid || (isGroup ? raw.key.participant : remoteJid);

  const context = contextOf(raw.message);

  // Real @mentions arrive as structured data — the mentioned person's JID —
  // rather than as text. This is what makes assignment exact (R1).
  //
  // WhatsApp now addresses group members by LID ("2807…@lid") rather than by
  // phone number, so a mention is often NOT resolvable here. Raw JIDs are passed
  // through for the client to translate against the group's participant list.
  const mentionJids = context?.mentionedJid || [];
  const mentions = mentionJids.map(phone.fromJid).filter(Boolean);

  return {
    id: raw.key.id,
    groupId: isGroup ? remoteJid : null,
    // Always set, group or DM — identifies the conversation.
    chatId: remoteJid,
    /**
     * Where a reply is addressed: the conversation it arrived on.
     *
     * This must stay the same address the message came from. WhatsApp keeps one
     * encryption session per conversation, so answering a LID-addressed chat on
     * the sender's phone JID instead opens a SECOND session with the same
     * person — and the recipient's phone then cannot read what we send, which
     * is what "Waiting for this message" is.
     *
     * It was briefly the phone JID, on the belief that LID replies did not
     * route. That was wrong: replies were disappearing because resolving the
     * LID blocked for a minute first (see prepareAndEmit), and fixing the real
     * cause made the reply target moot. `WA_REPLY_TO=pn` restores the old
     * behaviour without a deploy if this ever turns out to be backwards.
     */
    replyTo: (!isGroup && senderPnJid && config.whatsapp.replyTo === 'pn')
      ? senderPnJid
      : remoteJid,
    isGroup,
    fromMe: Boolean(raw.key.fromMe),
    senderPhone: phone.fromJid(senderJid),
    senderJid: senderJid || null,
    /** The sender's real phone JID, when WhatsApp supplied one. */
    senderPnJid,
    // True only when we are still holding a LID with no number beside it —
    // senderPnJid above resolves the common case without a lookup.
    senderIsLid: Boolean(senderJid && phone.isLid(senderJid)),
    /**
     * The sender's WhatsApp profile name.
     *
     * Whatever they set for themselves, so it is not proof of identity and
     * never fills a structured field on its own. But it is a far better thing
     * to call a lead than its own phone number, which is what the CRM was
     * filling up with — "a list of phone numbers", as their team put it. A real
     * name stated in conversation replaces it later.
     */
    pushName: raw.pushName || null,
    text: textOf(unwrap(raw.message)),
    mentions: [...new Set(mentions)],
    mentionJids,
    // Unresolved LIDs, for the client to translate.
    pendingLids: mentionJids.filter((j) => String(j).endsWith('@lid')),
    // stanzaId identifies the message being replied to. Matching on this is exact,
    // unlike v1's comparison of quoted message text.
    quotedId: context?.stanzaId || null,
    quotedText: textOf(context?.quotedMessage) || null,
    timestamp: Number(raw.messageTimestamp) || Math.floor(Date.now() / 1000)
  };
}

/**
 * Build the mention payload WhatsApp needs to render an @name in an outgoing
 * message. The text must contain "@<number>" for the tag to render.
 *
 * @param {string[]} e164List
 * @returns {string[]} JIDs
 */
function toMentionJids(e164List) {
  return (e164List || [])
    .filter(Boolean)
    .map((e164) => `${e164.replace(/^\+/, '')}@s.whatsapp.net`);
}

module.exports = { normalise, textOf, contextOf, toMentionJids, unwrap };
