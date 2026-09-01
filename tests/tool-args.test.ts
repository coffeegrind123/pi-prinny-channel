/**
 * `args: { args: { … } }`, and the 400 it used to produce.
 *
 * On 2026-09-01 the model called
 * `{"action":"react","args":{"args":{"emoji":"\u{1F60F}"}}}`. The extension
 * spread `params.args`, got `{ args: { emoji } }`, and passed that to the
 * sidecar — where `args.emoji` was undefined, the `m.reaction` went out with no
 * `key`, and Synapse answered `[400] Missing aggregation key`.
 */

import { describe, expect, it } from './harness.ts';

import { unwrapDoubleArgs } from '../src/tool-args.ts';

describe('unwrapDoubleArgs', () => {
  it('unwraps the shape that produced the reaction 400', () => {
    expect(unwrapDoubleArgs({ args: { emoji: '\u{1F60F}' } })).toEqual({ emoji: '\u{1F60F}' });
  });

  it('leaves an ordinary call exactly as written', () => {
    expect(unwrapDoubleArgs({ emoji: '\u{1F648}' })).toEqual({ emoji: '\u{1F648}' });
    expect(unwrapDoubleArgs({ text: 'hello', format: 'markdown' })).toEqual({
      text: 'hello',
      format: 'markdown',
    });
  });

  it('treats a missing or empty args as an empty object', () => {
    expect(unwrapDoubleArgs(undefined)).toEqual({});
    expect(unwrapDoubleArgs(null)).toEqual({});
    expect(unwrapDoubleArgs({})).toEqual({});
  });

  // The unwrap is only safe because the shape is unambiguous. A second key means
  // the caller meant something this function cannot work out, and guessing
  // there is worse than the call failing where the operator can see it.
  it('does not unwrap when there is anything else alongside args', () => {
    const both = { args: { emoji: 'x' }, room_id: '!r:s' };
    expect(unwrapDoubleArgs(both)).toEqual(both);
  });

  it('does not unwrap a non-object inner value', () => {
    for (const inner of ['a string', 42, true, null, ['a', 'b']]) {
      const raw = { args: inner } as Record<string, unknown>;
      expect(unwrapDoubleArgs(raw)).toEqual(raw);
    }
  });

  // Three deep is a different mistake and is not this function's to guess at:
  // one level is the observed error, and each extra level of "helpfulness" is a
  // call shape nobody has ever seen being repaired on a hunch.
  it('unwraps exactly one level, not all of them', () => {
    expect(unwrapDoubleArgs({ args: { args: { emoji: 'x' } } })).toEqual({ args: { emoji: 'x' } });
  });

  it('returns a copy, so a caller mutating it cannot reach back into params', () => {
    const inner = { emoji: 'x' };
    const out = unwrapDoubleArgs({ args: inner });
    out.room_id = '!r:s';
    expect(inner).toEqual({ emoji: 'x' });
  });
});
