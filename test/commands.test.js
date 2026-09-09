const { test, describe } = require('node:test');
const assert = require('node:assert');
const commands = require('../src/pipeline/commands');

describe('command detection', () => {
  test('recognises the command on its own', () => {
    for (const text of ['my leads', 'My Leads', 'MY LEADS.', 'myleads',
                        'my list', 'my open leads', 'mere leads']) {
      assert.equal(commands.parse(text)?.name, 'myLeads', `missed "${text}"`);
    }
  });

  test('recognises help', () => {
    for (const text of ['help', 'Help', 'commands', 'bot help']) {
      assert.equal(commands.parse(text)?.name, 'help', `missed "${text}"`);
    }
  });

  test('NEVER fires inside ordinary conversation', () => {
    // The property that matters. A bot that answers when someone happens to say
    // "help" is an interruption, not a tool — and this group is where the team
    // actually works.
    const CONVERSATION = [
      'let me check my leads later',
      'send me my leads for today please',
      'help him with the file',
      'I need help',
      'can you help me',
      'my leads are pending with bank',
      'sharing my leads now',
      'he needs help with documents',
      'my leads list is long'
    ];
    for (const text of CONVERSATION) {
      assert.equal(commands.parse(text), null, `misfired on "${text}"`);
    }
  });

  test('a long message is conversation whatever it contains', () => {
    assert.equal(commands.parse('my leads ' + 'x'.repeat(40)), null);
  });

  test('empty input is not a command', () => {
    assert.equal(commands.parse(''), null);
    assert.equal(commands.parse(null), null);
  });
});

describe('reassignment instructions', () => {
  const TAGGED = ['+919876543210'];

  test('recognises a clear instruction', () => {
    for (const text of ['assign @919876543210', 'Assign @919876543210',
                        'transfer @919876543210', 'move this lead to @919876543210',
                        'handover @919876543210', 'assign @919876543210 please']) {
      assert.equal(commands.parseReassign(text, TAGGED)?.to, '+919876543210',
        `missed "${text}"`);
    }
  });

  test('a bare tag is never an instruction', () => {
    // People tag each other constantly. Without the explicit word, every mention
    // in a reply would be a silent handover.
    assert.equal(commands.parseReassign('@919876543210', TAGGED), null);
    assert.equal(commands.parseReassign('thanks @919876543210', TAGGED), null);
  });

  test('a sentence that happens to open with a command word is not one', () => {
    // Length alone does not separate these — what does is that almost nothing is
    // left once the command word and the tag are removed.
    const SENTENCES = [
      'move to Canada next year is what he wants for his masters',
      'move him to processing stage after docs',
      'give him a call tomorrow morning',
      'transfer of funds already done from his side'
    ];
    for (const text of SENTENCES) {
      assert.equal(commands.parseReassign(text, TAGGED), null, `misfired on "${text}"`);
    }
  });

  test('ambiguity is reported, never guessed', () => {
    assert.equal(commands.parseReassign('assign', []).error, 'no_mention');
    assert.equal(
      commands.parseReassign('assign @a @b', ['+911111111111', '+912222222222']).error,
      'multiple_mentions'
    );
  });
});
