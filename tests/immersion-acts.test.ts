/**
 * The persona's reach into Matrix, and the thing that stops it being spam.
 *
 * THE LOAD-BEARING TEST is "a refusal reads as normal, not as a failure". A
 * model that reads "refused" as "the tool broke" starts explaining itself to the
 * user, apologising, or retrying — all of which are worse than the spam the
 * cooldown exists to prevent.
 *
 * Its control is that the cooldown actually refuses: a policy that allowed
 * everything would pass any assertion about wording.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  check,
  clampStatus,
  clampTopic,
  cooldownFor,
  immersionNudge,
  MAX_PERSONA_STATUS,
  MAX_TOPIC,
  STATUS_COOLDOWN_MS,
  TOPIC_COOLDOWN_MS,
} from '../src/immersion-acts.ts';

describe('the cooldown', () => {
  it('allows the first one', () => {
    assert.equal(check('status', undefined, 1000).allowed, true);
  });

  // `undefined` means never; 0 is a real timestamp. They used to be the same
  // thing through a `!lastAt` check, which made the first cooldown untestable
  // and would have let an act at epoch 0 run twice.
  it('tells "never ran" apart from "ran at time zero"', () => {
    assert.equal(check('status', undefined, 0).allowed, true, 'never ran');
    assert.equal(check('status', 0, 0).allowed, false, 'ran at time 0, so still cooling');
  });

  // The control for everything below.
  it('refuses inside the window and allows after it', () => {
    assert.equal(check('status', 0, STATUS_COOLDOWN_MS - 1).allowed, false);
    assert.equal(check('status', 0, STATUS_COOLDOWN_MS).allowed, true);
    assert.equal(check('topic', 0, TOPIC_COOLDOWN_MS - 1).allowed, false);
    assert.equal(check('topic', 0, TOPIC_COOLDOWN_MS).allowed, true);
  });

  // A topic is a state event in the timeline that everyone sees; a status sits
  // silently under a name. Different intrusion, different leash.
  it('gives a topic a much longer leash than a status', () => {
    assert.ok(cooldownFor('topic') > cooldownFor('status') * 3);
    assert.equal(cooldownFor('status'), STATUS_COOLDOWN_MS);
  });

  // THE LOAD-BEARING ONE.
  it('words a refusal as normal, and tells the model not to react to it', () => {
    const v = check('status', 0, 60_000);
    assert.equal(v.allowed, false);
    const r = v.reason;
    assert.ok(/normal refusal, not a failure/i.test(r), r);
    assert.ok(/do not mention it or retry/i.test(r), r);
    assert.ok(/carry on/i.test(r), r);
    // It must not read as an error the model should surface or fix.
    assert.ok(!/\berror\b/i.test(r), r);
    assert.ok(!/\bfailed\b/i.test(r), r);
  });

  it('says how long is left, in words rather than milliseconds', () => {
    const v = check('topic', 0, 60_000);
    assert.ok(v.waitMs > 0);
    assert.ok(/minutes|hour/.test(v.reason), v.reason);
    assert.ok(!/\d{4,}/.test(v.reason), 'no raw millisecond counts');
  });
});

describe('what gets sent', () => {
  it('flattens and bounds a status', () => {
    assert.equal(clampStatus('  reading   the\ncompiler '), 'reading the compiler');
    const long = clampStatus('x'.repeat(200));
    assert.equal(long.length, MAX_PERSONA_STATUS);
    assert.ok(long.endsWith('…'));
  });

  it('flattens and bounds a topic, which gets more room', () => {
    assert.equal(clampTopic(' a  b '), 'a b');
    assert.equal(clampTopic('y'.repeat(500)).length, MAX_TOPIC);
    assert.ok(MAX_TOPIC > MAX_PERSONA_STATUS);
  });

  it('an empty value survives, because clearing is a real thing to do', () => {
    assert.equal(clampStatus(''), '');
    assert.equal(clampTopic('   '), '');
  });
});

describe('the nudge', () => {
  const text = immersionNudge('Crystal', true);

  it('names the persona and both actions', () => {
    assert.ok(text.includes('Crystal'));
    assert.ok(text.includes('prinny(action: "status"'));
    assert.ok(text.includes('prinny(action: "topic"'));
  });

  // Without this a model reads any mention of a capability as an instruction to
  // exercise it, which is exactly the spam the cooldown is fighting.
  it('says plainly that doing nothing is the normal case', () => {
    assert.ok(/Doing neither is the normal case/i.test(text));
    assert.ok(/Most turns warrant nothing at all/i.test(text));
    assert.ok(/worse than none/i.test(text));
  });

  it('warns that a topic is the loud one', () => {
    assert.ok(/LOUD/.test(text));
    assert.ok(/state event/i.test(text));
  });

  it('tells the model in advance how to read a refusal', () => {
    assert.ok(/refused because it is too soon/i.test(text));
    assert.ok(/Do not retry it/i.test(text));
  });

  // A room where the bot has no power to set state should not be told about a
  // tool that will always refuse.
  it('leaves the topic out when it is not available', () => {
    const noTopic = immersionNudge('Crystal', false);
    assert.ok(!noTopic.includes('prinny(action: "topic"'));
    assert.ok(noTopic.includes('prinny(action: "status"'));
  });
});
