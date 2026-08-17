/**
 * Who should be seeing a typing indicator.
 *
 * The sidecar sets typing when a message arrives and Matrix expires it on its
 * own timeout (20s). A local 27B model routinely thinks for longer, so the
 * indicator lapsed mid-thought — the sender saw a bot that had gone quiet at
 * exactly the moment the signal was meant to say "still working".
 */

import { describe, expect, it } from './harness.ts';
import { planStopAll, planTyping } from '../src/typing.ts';

describe('planTyping', () => {
  it('starts an indicator for a room that is waiting', () => {
    const plan = planTyping(['!a:x'], new Set());
    expect(plan.start).toEqual(['!a:x']);
    expect(plan.stop).toEqual([]);
  });

  it('KEEPS re-sending for a room already typing — that is the refresh', () => {
    // The bug this exists for: treating an already-active room as a no-op lets
    // Matrix expire the indicator halfway through a long turn.
    const plan = planTyping(['!a:x'], new Set(['!a:x']));
    expect(plan.start).toEqual(['!a:x']);
    expect(plan.stop).toEqual([]);
  });

  it('stops a room that is no longer waiting, without touching the others', () => {
    const plan = planTyping(['!a:x'], new Set(['!a:x', '!b:x']));
    expect(plan.start).toEqual(['!a:x']);
    expect(plan.stop).toEqual(['!b:x']);
  });

  it('stops everything when nothing is waiting', () => {
    const plan = planTyping([], new Set(['!a:x', '!b:x']));
    expect(plan.start).toEqual([]);
    expect(plan.stop.sort()).toEqual(['!a:x', '!b:x']);
  });

  it('is a no-op when there is nothing to do', () => {
    const plan = planTyping([], new Set());
    expect(plan.start).toEqual([]);
    expect(plan.stop).toEqual([]);
  });

  it('ignores empty room ids rather than sending typing to nowhere', () => {
    const plan = planTyping(['', '!a:x'], new Set());
    expect(plan.start).toEqual(['!a:x']);
  });

  it('does not duplicate a room listed twice', () => {
    const plan = planTyping(['!a:x', '!a:x'], new Set());
    expect(plan.start).toEqual(['!a:x']);
  });
});

describe('planStopAll', () => {
  it('clears every active room regardless of who is waiting', () => {
    // A stuck typing indicator is the classic bot bug, and the only reliable
    // fix is a stop that does not depend on the state that started it.
    const plan = planStopAll(new Set(['!a:x', '!b:x']));
    expect(plan.start).toEqual([]);
    expect(plan.stop.sort()).toEqual(['!a:x', '!b:x']);
  });

  it('is safe when nothing is active', () => {
    expect(planStopAll(new Set())).toEqual({ start: [], stop: [] });
  });
});
