/**
 * §11.12, closed — this channel will not abort somebody else's compaction.
 *
 * AD3 made a Matrix `/compact` wait for `agent_settled`, on the grounds that "by
 * then aborting costs nothing because the run is over". AE2 found the run this
 * handler starts itself one line earlier. This is the third thing in that
 * moment: `vendor/pi-loop-mode`'s `agent_settled` handler runs BEFORE this one
 * and may already have asked for an emergency compaction, and pi's `compact()`
 * does not refuse a second call — `await this.abort()` is its first statement.
 *
 * The fix is a lock neither package owns: `src/compaction-lock.ts` here and in
 * `vendor/pi-loop-mode/src/compaction-lock.ts`, one `globalThis` key, two
 * implementations. Duplicated deliberately — vendor packages must not import each
 * other — which is the arrangement `stateDir()` already has between
 * `src/config.ts` and `server/src/state.ts`, and which is only as good as the
 * assertion that the two agree. So this suite imports both.
 *
 * Executed end to end, through both real extensions in one process, in
 * `context/testing/probes/s5-two-extensions-one-compaction.mjs`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPACTION_LOCK_KEY,
  PRINNY_OWNER,
  STALE_MS,
  beginCompaction,
  compactionInFlight,
  endCompaction,
  resetCompactionLock,
} from '../src/compaction-lock.ts';
import * as loop from '../../pi-loop-mode/src/compaction-lock.ts';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe('the compaction lock', () => {
  beforeEach(() => {
    resetCompactionLock();
  });

  it('hands the lock to the first asker and refuses the second', () => {
    assert.equal(beginCompaction(PRINNY_OWNER), true);
    assert.equal(beginCompaction('somebody-else'), false);
    assert.equal(compactionInFlight()?.owner, PRINNY_OWNER);
  });

  it('is re-entrant for the same owner', () => {
    // `startCompaction` is reached directly and through
    // `drainPendingCompaction`; only one of those can be in flight, and the next
    // reader should not have to prove it.
    assert.equal(beginCompaction(PRINNY_OWNER), true);
    assert.equal(beginCompaction(PRINNY_OWNER), true);
  });

  it('only the owner can release it', () => {
    beginCompaction(PRINNY_OWNER);
    endCompaction('somebody-else');
    assert.equal(compactionInFlight()?.owner, PRINNY_OWNER);
    endCompaction(PRINNY_OWNER);
    assert.equal(compactionInFlight(), undefined);
  });

  it('expires, so a lost release costs one wait and not the channel', () => {
    const t0 = 1_000_000;
    beginCompaction(PRINNY_OWNER, t0);
    assert.equal(compactionInFlight(t0 + STALE_MS - 1)?.owner, PRINNY_OWNER);
    assert.equal(compactionInFlight(t0 + STALE_MS), undefined);
  });

  it('ignores a global somebody else wrote', () => {
    (globalThis as unknown as Record<string, unknown>)[COMPACTION_LOCK_KEY] = { owner: 5, at: 'now' };
    assert.equal(compactionInFlight(), undefined);
    assert.equal(beginCompaction(PRINNY_OWNER), true);
  });
});

describe('the two implementations agree', () => {
  beforeEach(() => {
    resetCompactionLock();
  });

  it('on the key and the bound', () => {
    assert.equal(loop.COMPACTION_LOCK_KEY, COMPACTION_LOCK_KEY);
    assert.equal(loop.STALE_MS, STALE_MS);
  });

  it('and this package does not import that one', () => {
    const source = readFileSync(join(PACKAGE_ROOT, 'src', 'compaction-lock.ts'), 'utf8');
    assert.doesNotMatch(source, /from ["'].*pi-loop-mode/);
    assert.equal(loop.LOOP_OWNER, 'pi-loop-mode');
  });

  it("so the loop's hold really does refuse this channel", () => {
    assert.equal(loop.beginCompaction(loop.LOOP_OWNER), true);
    assert.equal(beginCompaction(PRINNY_OWNER), false, 'we must see the loop\'s hold');
    assert.equal(compactionInFlight()?.owner, loop.LOOP_OWNER);
    loop.endCompaction(loop.LOOP_OWNER);
    assert.equal(beginCompaction(PRINNY_OWNER), true);
    endCompaction(PRINNY_OWNER);
  });
});

describe('§11.12 — the wiring', () => {
  const source = readFileSync(join(PACKAGE_ROOT, 'extensions', 'index.ts'), 'utf8');
  const fn = source.slice(source.indexOf('function startCompaction('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  it('asks whether somebody is already compacting BEFORE asking pi to compact', () => {
    const checked = body.indexOf('const holder = compactionInFlight();');
    const asked = body.indexOf('uiCtx.compact({');
    assert.ok(checked > 0, 'the question is asked');
    assert.ok(checked < asked, '…before the call that would abort the other compaction');
  });

  it('tells the sender their compaction is happening, without claiming it finished', () => {
    assert.match(body, /A compaction is already running/);
    // The claim is deliberately about the OTHER compaction running, not about
    // this one having completed — AD4's rule, one mechanism over: say what this
    // extension knows, not what pi did.
    const alreadyAt = body.indexOf('A compaction is already running');
    const doneAt = body.indexOf('Compacted the conversation context.');
    assert.ok(alreadyAt < doneAt, 'the stand-aside reply is not the completion reply');
  });

  it('releases on every path pi can take', () => {
    // onComplete, onError, and the synchronous throw out of a stale runtime.
    assert.equal((body.match(/endCompaction\(PRINNY_OWNER\)/g) ?? []).length, 3);
    assert.match(body, /beginCompaction\(PRINNY_OWNER\)/);
  });
});
