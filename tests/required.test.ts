/**
 * The sidecar answering for its own contract.
 *
 * The MCP SDK publishes `inputSchema` and validates nothing against it, so a
 * parameter the model omitted reached the operation as `undefined` and whatever
 * was downstream answered for it. For `react` that was Synapse, with
 * `[400] Missing aggregation key` — a sentence that names neither the tool, nor
 * the call, nor the parameter that was actually missing.
 */

import { describe, expect, it } from './harness.ts';

import { missingRequired, requiredParamError } from '../server/src/required.ts';

/** react's real schema, minLength and all. */
const REACT = {
  required: ['room_id', 'message_id', 'emoji'],
  properties: { emoji: { minLength: 1 } },
};

/** set_biography's, where an empty string is a legitimate value: "Empty clears it." */
const BIOGRAPHY = { required: ['text'], properties: { text: {} } };

describe('missingRequired', () => {
  it('accepts a complete call', () => {
    expect(missingRequired(REACT, { room_id: '!r:s', message_id: '$e', emoji: '\u{1F60F}' })).toEqual([]);
  });

  it('names every absent parameter, in the schema order', () => {
    expect(missingRequired(REACT, { message_id: '$e' })).toEqual(['room_id', 'emoji']);
  });

  it('counts null as absent', () => {
    expect(missingRequired(REACT, { room_id: '!r:s', message_id: '$e', emoji: null })).toEqual(['emoji']);
  });

  // Only where the schema says so. An empty reaction key is refused by the
  // homeserver with the same opaque 400 as a missing one, so `emoji` carries
  // minLength: 1.
  it('counts an empty or whitespace-only string as absent WHERE minLength says so', () => {
    expect(missingRequired(REACT, { room_id: '!r:s', message_id: '$e', emoji: '' })).toEqual(['emoji']);
    expect(missingRequired(REACT, { room_id: '!r:s', message_id: '$e', emoji: '   ' })).toEqual(['emoji']);
  });

  // The regression this rule nearly caused. `set_biography`'s own description is
  // "Empty clears it", and a blanket empty-is-missing check would have made
  // clearing a biography impossible — trading a rare opaque error for a common
  // broken feature.
  it('accepts an empty string where the schema does not forbid one', () => {
    expect(missingRequired(BIOGRAPHY, { text: '' })).toEqual([]);
    expect(missingRequired(BIOGRAPHY, { text: '   ' })).toEqual([]);
    expect(missingRequired({ required: ['topic'] }, { topic: '' })).toEqual([]);
  });

  it('leaves non-string falsy values alone — false and 0 are answers', () => {
    expect(missingRequired({ required: ['room_id', 'active'] }, { room_id: '!r:s', active: false })).toEqual([]);
    expect(missingRequired({ required: ['n'], properties: { n: { minLength: 1 } } }, { n: 0 })).toEqual([]);
  });

  it('has nothing to say about a tool with no required list', () => {
    expect(missingRequired(undefined, {})).toEqual([]);
    expect(missingRequired({}, { anything: 1 })).toEqual([]);
    expect(missingRequired({ required: [] }, { anything: 1 })).toEqual([]);
  });
});

describe('requiredParamError', () => {
  it('is null for a call that is fine', () => {
    expect(requiredParamError('react', REACT, { room_id: '!r:s', message_id: '$e', emoji: 'x' })).toBe(null);
  });

  // The received-keys half is the point. Without it the model is told it forgot
  // `emoji` and cannot see that it sent `args` when it meant the contents of
  // `args` — which is the mistake that actually happened.
  it('names the tool, what is missing, what is wanted, and what arrived', () => {
    const message = requiredParamError('react', REACT, { room_id: '!r:s', message_id: '$e', args: {} })!;
    expect(message).toContain('react is missing required parameter: emoji');
    expect(message).toContain('It takes room_id, message_id, emoji');
    expect(message).toContain('it received room_id, message_id, args');
  });

  it('pluralises honestly', () => {
    expect(requiredParamError('react', REACT, {})!).toContain('missing required parameters: room_id, message_id, emoji');
    expect(requiredParamError('react', REACT, { room_id: '!r', message_id: '$e' })!).toContain(
      'missing required parameter: emoji'
    );
  });

  it('says so when nothing at all arrived', () => {
    expect(requiredParamError('react', REACT, {})!).toContain('it received nothing');
  });
});
