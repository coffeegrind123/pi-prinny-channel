/**
 * AD3 (thirteenth pass) — a Matrix `/compact` must not cancel the turn in flight.
 *
 * `ExtensionContext.compact` is `AgentSession.compact`, whose first statement is
 * `await this.abort()`. AC5 made the command real without that being noticed, so
 * from the twelfth pass onward an allow-listed sender could cancel the
 * operator's work from a phone — and, through `vendor/pi-loop-mode`'s
 * aborted-turn branch, pause an unattended run and have it recorded as
 * `Turn aborted by operator`.
 *
 * The damage is executed in `context/testing/probes/q3-…`; this is the rule.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from './harness.ts';
import { COMPACTION_DEFER_LIMIT, planCompaction, standAside } from '../src/compaction-request.ts';

describe('planCompaction', () => {
  it('waits when a turn is in flight, rather than cancelling it', () => {
    const plan = planCompaction({ hasSession: true, agentRunning: true });
    expect(plan.action).toBe('defer');
    expect((plan as { reply: string }).reply).toContain('mid-turn');
  });

  it('runs immediately on an idle session, which is the common case', () => {
    expect(planCompaction({ hasSession: true, agentRunning: false })).toEqual({ action: 'now' });
  });

  it('says "no session" rather than "not right now" when there is no session', () => {
    // Two different sentences on purpose: telling somebody to wait for a turn
    // that does not exist is worse than either answer on its own.
    const plan = planCompaction({ hasSession: false, agentRunning: false });
    expect(plan.action).toBe('unavailable');
    expect((plan as { reply: string }).reply).toContain('no session is open');
  });

  it('answers "no session" even while something claims to be running', () => {
    // The flags can disagree — `agentRunning` is set from `agent_start` and
    // `uiCtx` from `session_start`/`agent_start`, and a replaced session clears
    // one without the other. The more specific fault wins.
    const plan = planCompaction({ hasSession: false, agentRunning: true });
    expect(plan.action).toBe('unavailable');
  });

  it('never answers with a bare boolean', () => {
    // The reply text is part of the decision: the whole finding is that the
    // sender was told one thing while another happened, so a plan without a
    // sentence would leave the caller to invent one again.
    for (const input of [
      { hasSession: false, agentRunning: false },
      { hasSession: true, agentRunning: true },
    ]) {
      const plan = planCompaction(input) as { reply?: string };
      expect(typeof plan.reply).toBe('string');
    }
  });
});

/**
 * The wiring, pinned — `extensions/index.ts` imports pi and cannot be loaded
 * here, so this is a source pin and says so. The execution that matters (what an
 * abort does to a running loop) is `context/testing/probes/q3-…`.
 */
describe('the wiring the rule needs', () => {
  const source = readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('runLocalCommand asks planCompaction instead of calling compact() outright', () => {
    const body = source.slice(source.indexOf('function runLocalCommand('));
    expect(/planCompaction\(\{ hasSession: Boolean\(uiCtx\), agentRunning \}\)/.test(body)).toBe(true);
    // The old form: uiCtx.compact() reached directly from the inbound path.
    expect(/uiCtx\.compact\(/.test(body.slice(0, body.indexOf('function startCompaction')))).toBe(false);
  });

  it('a deferred request is drained at agent_settled, after the answer is forwarded', () => {
    const settled = source.slice(source.indexOf("pi.on('agent_settled'"));
    const handler = settled.slice(0, settled.indexOf('});'));
    const forward = handler.indexOf('await forwardResult();');
    const drain = handler.indexOf('drainPendingCompaction();');
    expect(drain).not.toBe(-1);
    expect(forward < drain).toBe(true);
  });

  it('the pending slot is cleared before the compaction starts, so a failure cannot latch it', () => {
    const drain = source.slice(source.indexOf('function drainPendingCompaction('));
    const cleared = drain.indexOf('pendingCompaction = undefined;');
    const started = drain.indexOf('startCompaction(');
    expect(cleared).not.toBe(-1);
    expect(cleared < started).toBe(true);
  });

  /**
   * AD4. "Ran `X`" was AC5's own objection — a claim made on the strength of
   * having CALLED the function — and AC5 fixed only the command pi cannot
   * dispatch. For the ones it can, pi's `_tryExecuteExtensionCommand` catches a
   * throwing handler, emits an extension error nobody listens to headless, and
   * returns `true`, so `prompt()` resolves on a command that failed. And AC4's
   * `answered` flag exempts the entry from the undelivered sweep. Nothing here
   * can observe the outcome, so the sentence says what this extension did.
   */
  it('the command confirmation claims delivery, not success', () => {
    const run = source.slice(source.indexOf("if (command.kind === 'run')"));
    const branch = run.slice(0, run.indexOf('return;'));
    expect(/Handed \\`\$\{command\.text\}\\` to the session/.test(branch)).toBe(true);
    expect(/Ran \\`/.test(branch)).toBe(false);
    expect(/cannot see whether it succeeded/.test(branch)).toBe(true);
  });
});

/**
 * AE2 (fourteenth pass) — AD3's premise, falsified one line above the fix.
 *
 * AD3's whole argument for deferring to `agent_settled` is that "by then
 * aborting costs nothing because the run is over". That is true of the run that
 * ended and false of the one the same handler starts:
 *
 *     agentRunning = false
 *     stopTyping()
 *     await forwardResult()      ← the empty-turn continuation is sent here
 *     drainPendingCompaction()   ← and pi's compact() begins `await this.abort()`
 *
 * The two conditions are correlated rather than independent: a sender asks for a
 * compaction BECAUSE the bot has gone quiet, and an empty ending is what quiet
 * looks like from inside.
 *
 * Executed in `context/testing/probes/r3-…`, mode `settling-together`. This is
 * the rule, and the bound.
 */
describe('standAside', () => {
  const pending = { room: '!r:example.org', at: 1 };

  it('holds the compaction back when a continuation has just been started', () => {
    const held = standAside(pending, true);
    expect(held.wait).toBe(true);
    expect((held as { pending: { stoodAside?: number } }).pending.stoodAside).toBe(1);
  });

  it('runs it when nothing was started — which is every ordinary settlement', () => {
    expect(standAside(pending, false)).toEqual({ wait: false });
  });

  it('is a no-op when nothing is waiting', () => {
    expect(standAside(undefined, true)).toEqual({ wait: false });
  });

  it('stops standing aside once the continuation budget is spent', () => {
    // A continuation that never actually starts is not hypothetical — that is
    // AE4, and `sendUserMessage` cannot report it. An unbounded stand-aside would
    // leave the sender waiting for a compaction they were told would happen "as
    // soon as it finishes".
    let current: { room: string; at: number; stoodAside?: number } = pending;
    for (let round = 0; round < COMPACTION_DEFER_LIMIT; round += 1) {
      const held = standAside(current, true);
      expect(held.wait).toBe(true);
      current = (held as { pending: typeof current }).pending;
    }
    expect(standAside(current, true)).toEqual({ wait: false });
  });

  it('does not mutate the request it was given', () => {
    // The caller assigns the returned value; a rule that edited its input would
    // have counted a stand-aside that never happened on the `wait: false` path.
    const original = { room: '!r:example.org', at: 1 };
    standAside(original, true);
    expect(original).toEqual({ room: '!r:example.org', at: 1 });
  });

  it('the bound is the continuation budget, not a number of its own', () => {
    // Same reasoning as MAX_CHECK_ERRORS matching CONTEXT_RECOVERY_ATTEMPTS in
    // the loop: this stands aside for exactly one mechanism, so it is bounded by
    // that mechanism's own budget rather than by a second, drifting constant.
    const continuation = readFileSync(new URL('../src/continuation.ts', import.meta.url), 'utf8');
    const declared = /MAX_EMPTY_RETRIES = (\d+)/.exec(continuation)?.[1];
    expect(Number(declared)).toBe(COMPACTION_DEFER_LIMIT);
  });
});

describe('AE2 — the wiring, where the rule is applied', () => {
  const source = readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf8');
  const settled = source.slice(source.indexOf("pi.on('agent_settled'"));
  const body = settled.slice(0, settled.indexOf('\n  });'));

  it('asks whether a continuation was started before draining', () => {
    expect(body).toContain('const continuationStarted = await forwardResult();');
    expect(body).toContain('standAside(pendingCompaction, continuationStarted)');
  });

  it('drains only on the branch that decided it may', () => {
    const drainAt = body.indexOf('drainPendingCompaction();');
    const asideAt = body.indexOf('standAside(');
    expect(drainAt > asideAt).toBe(true);
  });

  it('control — forwardResult reports what it did, or the question is unanswerable', () => {
    // It used to return void, which is why the ordering was invisible: the
    // handler could not have asked.
    expect(source).toContain('async function forwardResult(): Promise<boolean>');
    expect(source).toContain('return retrying;');
  });
});
