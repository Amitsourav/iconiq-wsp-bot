const { test, describe } = require('node:test');
const assert = require('node:assert');
const messages = require('../src/whatsapp/messages');

/** A plain group message. */
const groupText = (text, over = {}) => {
  const { key: keyOver, ...rest } = over;
  return {
    key: {
      id: 'MSG1',
      remoteJid: '120363999@g.us',
      participant: '919876543210@s.whatsapp.net',
      fromMe: false,
      ...keyOver
    },
    message: { conversation: text },
    messageTimestamp: 1754400000,
    ...rest
  };
};

/** A message with an @mention and/or a quoted parent. */
const richText = (text, { mentioned = [], quotedId = null, quotedText = null } = {}) => ({
  key: { id: 'MSG2', remoteJid: '120363999@g.us', participant: '919876543210@s.whatsapp.net' },
  message: {
    extendedTextMessage: {
      text,
      contextInfo: {
        mentionedJid: mentioned,
        stanzaId: quotedId,
        quotedMessage: quotedText ? { conversation: quotedText } : undefined
      }
    }
  },
  messageTimestamp: 1754400000
});

describe('normalise', () => {
  test('reads a plain group message', () => {
    const m = messages.normalise(groupText('New lead'));
    assert.equal(m.id, 'MSG1');
    assert.equal(m.isGroup, true);
    assert.equal(m.groupId, '120363999@g.us');
    assert.equal(m.text, 'New lead');
    // In a group the sender is `participant`, not remoteJid.
    assert.equal(m.senderPhone, '+919876543210');
  });

  test('flags our own messages so they can be ignored (S1)', () => {
    const m = messages.normalise(groupText('bot output', { key: { fromMe: true } }));
    assert.equal(m.fromMe, true);
  });

  test('extracts @mentions as phone numbers, not text', () => {
    // This is what makes assignment exact — WhatsApp carries the mentioned
    // person's JID as structured data (R1).
    const m = messages.normalise(richText('New lead @Rahul', {
      mentioned: ['919812345678@s.whatsapp.net']
    }));
    assert.deepEqual(m.mentions, ['+919812345678']);
  });

  test('deduplicates a person mentioned twice', () => {
    const m = messages.normalise(richText('@Rahul @Rahul', {
      mentioned: ['919812345678@s.whatsapp.net', '919812345678@s.whatsapp.net']
    }));
    assert.deepEqual(m.mentions, ['+919812345678']);
  });

  test('captures several distinct mentions (Q9)', () => {
    const m = messages.normalise(richText('@Rahul @Priya', {
      mentioned: ['919812345678@s.whatsapp.net', '919999888877@s.whatsapp.net']
    }));
    assert.equal(m.mentions.length, 2);
  });

  test('captures the quoted message id, not its text', () => {
    // v1 compared quoted TEXT and missed on any whitespace difference.
    const m = messages.normalise(richText('University: DU', {
      quotedId: 'PARENT_MSG', quotedText: 'New lead\nPriya'
    }));
    assert.equal(m.quotedId, 'PARENT_MSG');
    assert.equal(m.quotedText, 'New lead\nPriya');
  });

  test('reads captions on images and documents', () => {
    const withCaption = {
      key: { id: 'M', remoteJid: '120363999@g.us', participant: '919876543210@s.whatsapp.net' },
      message: { imageMessage: { caption: 'Lead: Priya 9812345678' } }
    };
    assert.equal(messages.normalise(withCaption).text, 'Lead: Priya 9812345678');
  });

  test('unwraps disappearing messages', () => {
    const ephemeral = {
      key: { id: 'M', remoteJid: '120363999@g.us', participant: '919876543210@s.whatsapp.net' },
      message: { ephemeralMessage: { message: { conversation: 'vanishing lead' } } }
    };
    assert.equal(messages.normalise(ephemeral).text, 'vanishing lead');
  });

  test('marks direct messages as not group', () => {
    const dm = {
      key: { id: 'M', remoteJid: '919876543210@s.whatsapp.net' },
      message: { conversation: 'hi' }
    };
    const m = messages.normalise(dm);
    assert.equal(m.isGroup, false);
    assert.equal(m.groupId, null);
  });

  test('returns null for a message with no id', () => {
    assert.equal(messages.normalise({}), null);
    assert.equal(messages.normalise(null), null);
  });

  test('a message with no text still normalises', () => {
    const sticker = {
      key: { id: 'M', remoteJid: '120363999@g.us', participant: '919876543210@s.whatsapp.net' },
      message: { stickerMessage: {} }
    };
    assert.equal(messages.normalise(sticker).text, null);
  });
});

describe('toMentionJids', () => {
  test('converts E.164 back to JIDs for outgoing tags', () => {
    assert.deepEqual(
      messages.toMentionJids(['+919812345678']),
      ['919812345678@s.whatsapp.net']
    );
  });

  test('ignores empties', () => {
    assert.deepEqual(messages.toMentionJids([null, undefined, '']), []);
    assert.deepEqual(messages.toMentionJids(null), []);
  });
});

describe('LID addressing (regression — found in live testing)', () => {
  test('a LID mention is surfaced for resolution, not silently dropped', () => {
    // WhatsApp now addresses group members by an internal LID rather than a phone
    // number. Treating an unresolvable mention as "no mention" made every tagged
    // lead look untagged, and held them all.
    const m = messages.normalise({
      key: { id: 'M', remoteJid: '120363999@g.us', participant: '126851909435470@lid' },
      message: {
        extendedTextMessage: {
          text: 'New lead @280715371515984',
          contextInfo: { mentionedJid: ['280715371515984@lid'] }
        }
      }
    });

    assert.deepEqual(m.mentions, [], 'not resolvable without the participant list');
    assert.deepEqual(m.pendingLids, ['280715371515984@lid'], 'but must be handed on');
    assert.equal(m.senderIsLid, true);
  });

  test('phone-number mentions still resolve directly', () => {
    const m = messages.normalise({
      key: { id: 'M', remoteJid: '120363999@g.us', participant: '919876543210@s.whatsapp.net' },
      message: {
        extendedTextMessage: {
          text: 'New lead @919812345678',
          contextInfo: { mentionedJid: ['919812345678@s.whatsapp.net'] }
        }
      }
    });
    assert.deepEqual(m.mentions, ['+919812345678']);
    assert.deepEqual(m.pendingLids, []);
  });
});
