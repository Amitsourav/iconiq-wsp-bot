/**
 * Pull the parts we care about out of a Baileys message.
 *
 * Kept pure and separate from the socket so it can be tested against captured
 * message shapes without a WhatsApp connection.
 */
const phone = require('../pipeline/phone');
const { config } = require('../config');

/** The envelopes WhatsApp puts around a message's real content. */
const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage', 'botInvokeMessage', 'deviceSentMessage'
];

/**
 * Unwrap the layers WhatsApp uses for disappearing, view-once, edited and
 * relayed messages. They can nest, so this keeps going until none is left.
 */
function unwrap(message) {
  let inner = message;
  for (let depth = 0; inner && depth < 5; depth++) {
    const key = WRAPPERS.find((k) => inner[k]?.message);
    if (!key) break;
    inner = inner[key].message;
  }
  return inner;
}

/**
 * Extract the text body from any message type that carries one.
 *
 * Includes the button, list and menu types. Meta's Business AI and the
 * WhatsApp Business app's quick replies send those, and a customer tapping a
 * button answers with one; read as plain text only, both sides of such a
 * conversation came out empty and were dropped without a trace.
 *
 * @param {object} message - the `message` object from a Baileys message
 * @returns {string|null}
 */
function textOf(message) {
  const m = unwrap(message);
  if (!m) return null;

  const interactive = m.interactiveMessage;
  const parts = [
    m.conversation,
    m.extendedTextMessage?.text,
    m.imageMessage?.caption,
    m.videoMessage?.caption,
    m.documentMessage?.caption,
    // Messages with buttons or a list, as sent.
    m.buttonsMessage?.contentText,
    m.templateMessage?.hydratedTemplate?.hydratedContentText,
    m.templateMessage?.hydratedFourRowTemplate?.hydratedContentText,
    interactive?.header?.title && interactive?.body?.text
      ? `${interactive.header.title}\n${interactive.body.text}` : interactive?.body?.text,
    m.listMessage?.description || m.listMessage?.title,
    // A tap on a button, list row or menu, as answered.
    m.buttonsResponseMessage?.selectedDisplayText,
    m.templateButtonReplyMessage?.selectedDisplayText,
    m.listResponseMessage?.title,
    m.interactiveResponseMessage?.body?.text
  ];

  const text = parts.find((p) => typeof p === 'string' && p.trim());
  return text || null;
}

/**
 * What a message is, for logging one we could not read: its content types
 * and, when it is only a placeholder, why. Never its content.
 * @param {object} raw - a Baileys message
 * @returns {string}
 */
function describe(raw) {
  const inner = unwrap(raw?.message);
  const kinds = inner ? Object.keys(inner).filter((k) => k !== 'messageContextInfo') : [];
  const stub = raw?.messageStubType ? ` stub=${raw.messageStubType}` : '';
  return (kinds.join(',') || 'no content') + stub;
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
 * The encrypted vote in a poll update, or null.
 *
 * Carries no text — the choice is encrypted with the poll's own key, which
 * only the bot holds — so it is passed on as-is for the client to decrypt.
 */
function pollVoteOf(message) {
  const update = message?.pollUpdateMessage;
  if (!update?.pollCreationMessageKey?.id || !update.vote?.encPayload) return null;
  return {
    pollId: update.pollCreationMessageKey.id,
    encPayload: update.vote.encPayload,
    encIv: update.vote.encIv
  };
}

/** The first of these that is a phone-number JID, or null. */
function phoneJidOf(...jids) {
  return jids.find((jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')) || null;
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

  // Status updates, broadcast lists and channels are not conversations with us.
  // WhatsApp delivers Status posts as if from a chat called "status@broadcast",
  // and since nothing stopped them every contact's Status was being filed as
  // one long "customer" thread with no phone number — 111 posts of cricket
  // invitations and the like, retried by the nightly sync and counted as a
  // failure every night. Nobody can reply to them, so there is nothing to keep.
  if (remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) return null;

  const isGroup = remoteJid.endsWith('@g.us');

  // In a group the actual sender is `participant`; remoteJid is the group.
  //
  // Both may be LIDs rather than phone numbers. When they are, WhatsApp sends
  // the real number alongside on the key — so prefer it. Without this a DM's
  // LID gets read as a foreign phone number and the lead is filed under a
  // number that does not exist.
  //
  // Baileys 7 calls it `participantAlt` / `remoteJidAlt`; 6 called it
  // `participantPn` / `senderPn`. The "Alt" is whichever form the primary is
  // not, so it is only taken when it really is a phone JID.
  const senderPnJid = isGroup
    ? phoneJidOf(raw.key.participantAlt, raw.key.participantPn)
    : phoneJidOf(raw.key.remoteJidAlt, raw.key.senderPn);
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
    pollVote: pollVoteOf(unwrap(raw.message)),
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

module.exports = { normalise, textOf, contextOf, toMentionJids, unwrap, describe };
