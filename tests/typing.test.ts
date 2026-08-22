/**
 * Who should be seeing a typing indicator.
 *
 * The sidecar sets typing when a message arrives and Matrix expires it on its
 * own timeout (20s). A local 27B model routinely thinks for longer, so the
 * indicator lapsed mid-thought — the sender saw a bot that had gone quiet at
 * exactly the moment the signal was meant to say "still working".
 */

import { readFileSync } from 'node:fs';

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

/**
 * AL6 — the indicator a stopped channel left up.
 *
 * `planStopAll`'s own docstring names its callers: *"for the end of a turn or a
 * shutdown — state-independent on purpose"*. Two of `stopTyping`'s three callers
 * were the end of a turn, and the shutdown was not one of them.
 *
 * `stopChannel` runs on `session_shutdown`, on `/prinny stop`, and on both arms
 * of a restart. It clears the delivery sweep's interval, with a reason:
 *
 * > Nothing can be reported to a room once the sidecar is gone, and the sweep's
 * > only action is a reply. Cleared here so a stopped channel does not keep an
 * > interval alive to discover that.
 *
 * Every word of that is true of the typing interval too, thirty lines up in the
 * same file, and it was not cleared. Two consequences, and the second is the one
 * a person sees:
 *
 *   · the 8 s refresh kept firing `typing` calls at a sidecar that was gone,
 *     each one rejecting into `sendTyping`'s empty catch, until the next turn
 *     boundary that never comes;
 *   · nobody was ever sent `typing: false`, so every room the bot was composing
 *     in kept the indicator up until Matrix's own 20 s timeout expired it. The
 *     last thing a Matrix user sees of a session that has ended is a bot that
 *     appears to still be writing.
 *
 * Ordering is the other half. `stopTyping()` is not bookkeeping — its whole body
 * is outbound calls — so it has to run BEFORE `child = null`, which is exactly
 * the argument AI2 wrote one line above it for `abandonPendingCompaction`.
 *
 * See AL6 in `context/design/subagents-loop-verifier-lifetimes.md`.
 */
describe('AL6 — a stopped channel stops typing', () => {
  const source = readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf8');
  const stop = source.slice(source.indexOf('async function stopChannel'));
  const body = stop.slice(0, stop.indexOf('\n}\n'));

  it('clears the indicator when the channel stops', () => {
    expect(body).toContain('stopTyping();');
  });

  it('does it while the sidecar can still be reached', () => {
    // `callSidecar` goes through `requireChannel()`, which reads `child`.
    const clear = body.indexOf('stopTyping();');
    const detach = body.indexOf('child = null;');
    expect(clear >= 0 && detach > clear).toBe(true);
  });

  it('stops both of this file’s intervals, not one of two', () => {
    const typing = body.indexOf('stopTyping();');
    const delivery = body.indexOf('clearInterval(deliveryTimer);');
    expect(typing >= 0 && delivery >= 0).toBe(true);
  });

  it('sends a stop to every room that was told the bot was typing', () => {
    // What `stopTyping` actually does, pinned here because the wiring test
    // above only knows it is called.
    expect(planStopAll(new Set(['!a:x', '!b:x'])).stop).toEqual(['!a:x', '!b:x']);
    expect(planStopAll(new Set(['!a:x'])).start).toEqual([]);
  });
});
