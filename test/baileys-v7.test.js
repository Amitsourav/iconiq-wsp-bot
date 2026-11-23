/**
 * Baileys 7 reports a LID-addressed sender's real number under new names
 * (`remoteJidAlt`, `participantAlt`) and keeps a LID -> number map of its own.
 * These pin down that both are read, so a customer whose chat arrives by LID
 * still becomes a lead under their real number.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { normalise } = require('../src/whatsapp/messages');
const { WhatsAppClient } = require('../src/whatsapp/client');

describe('Baileys 7 phone numbers', () => {
  test('a DM over LID reads the number from remoteJidAlt', () => {
    const message = normalise({
      key: {
        id: 'v7-1', remoteJid: '79955161551055@lid',
        remoteJidAlt: '919812345000@s.whatsapp.net', fromMe: false
      },
      message: { conversation: 'hi' },
      messageTimestamp: 1
    });

    assert.equal(message.senderPnJid, '919812345000@s.whatsapp.net');
    assert.equal(message.senderPhone, '+919812345000');
    // Still answered on the chat it arrived on.
    assert.equal(message.replyTo, '79955161551055@lid');
    assert.equal(message.chatId, '79955161551055@lid');
  });

  test('a group message reads the number from participantAlt', () => {
    const message = normalise({
      key: {
        id: 'v7-2', remoteJid: '120363000000000000@g.us',
        participant: '2807000000000@lid',
        participantAlt: '919812345000@s.whatsapp.net', fromMe: false
      },
      message: { conversation: 'hello' },
      messageTimestamp: 1
    });

    assert.equal(message.senderPhone, '+919812345000');
  });

  test('an Alt that is itself a LID is never taken as a phone number', () => {
    // A chat addressed by phone carries its LID as the Alt — the other way round.
    const message = normalise({
      key: {
        id: 'v7-3', remoteJid: '919812345000@s.whatsapp.net',
        remoteJidAlt: '79955161551055@lid', fromMe: false
      },
      message: { conversation: 'hi' },
      messageTimestamp: 1
    });

    assert.equal(message.senderPnJid, null);
    assert.equal(message.senderPhone, '+919812345000');
  });

  test('a hidden DM number is looked up from the library\'s LID map', async () => {
    const client = new WhatsAppClient();
    client.sock = { signalRepository: { lidMapping: {
      getPNForLID: async (lid) => (lid === '79955161551055@lid' ? '919812345000:0@s.whatsapp.net' : null)
    } } };

    const emitted = [];
    client.on('message', (m) => emitted.push(m));
    const message = normalise({
      key: { id: 'v7-4', remoteJid: '79955161551055@lid', fromMe: false },
      message: { conversation: 'hi' },
      messageTimestamp: 1
    });

    await client.prepareAndEmit(message, {});
    // Device suffix stripped, so it reads as the person's number.
    assert.equal(emitted[0].senderPnJid, '919812345000@s.whatsapp.net');
  });

  test('no mapping, or a lookup that fails, leaves the chat anonymous rather than stuck', async () => {
    const client = new WhatsAppClient();
    client.sock = { signalRepository: { lidMapping: {
      getPNForLID: async () => { throw new Error('store unavailable'); }
    } } };

    const emitted = [];
    client.on('message', (m) => emitted.push(m));
    await client.prepareAndEmit(normalise({
      key: { id: 'v7-5', remoteJid: '11111111111111@lid', fromMe: false },
      message: { conversation: 'hi' },
      messageTimestamp: 1
    }), {});

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].senderPnJid, null);
  });
});
