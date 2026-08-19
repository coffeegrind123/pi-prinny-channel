/**
 * AB2 — a Matrix message pi refused to take, and nobody told anybody.
 *
 * `api.sendUserMessage` returns `void`. pi's own binding is
 * `this.sendUserMessage(...).catch(err => runner.emitError(...))`
 * (`agent-session.js:1855`), and `emitError` walks `runner.errorListeners`,
 * which has one possible member — registered at `agent-session.js:1809` only
 * when a UI bound one. There is no error event in `ExtensionEvent` for an
 * extension to subscribe to. So the failure is unobservable from inside the
 * extension, and `deliverInbound`'s `try`/`catch` sees only a synchronous
 * `assertActive()` throw.
 *
 * `AgentSession.prompt()` throws for reasons that happen on this stack:
 * a compaction in progress (`:805` — `/loop`'s stuck ladder and its context
 * recovery both call `ctx.compact()`, whose first statement is `await
 * this.abort()` and which holds `_compactionAbortController` throughout), no
 * model selected, and no usable provider auth, which here means the
 * llama-server is down.
 *
 * The sender saw nothing at all: the room went into `awaitingReply` on arrival,
 * `markLive` never fired because pi never consumed anything, and every later
 * stage is gated on `live`.
 *
 * The rule lives in `src/delivery.ts` so it can be tested without a session.
 * These are the cases it has to get right, and the last two are the ones a
 * careless version gets wrong.
 *
 * See AB2 in `context/design/subagents-loop-verifier-signals.md`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DELIVERY_GRACE_MS,
  mergeAwaiting,
  unansweredMessage,
  unansweredRooms,
  undeliveredMessage,
  undeliveredRooms,
} from '../src/delivery.ts';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOW = 1_800_000_000_000;

type Entry = { at: number; live: boolean; undeliveredReported?: boolean; answered?: boolean };

const rooms = (entries: Record<string, Entry>, agentRunning = false, now = NOW) =>
  undeliveredRooms(Object.entries(entries), now, agentRunning);

describe('AB2 — an inbound message pi never took', () => {
  it('is reported once the grace has passed and the session is idle', () => {
    assert.deepEqual(
      rooms({ '!a:example.org': { at: NOW - DELIVERY_GRACE_MS - 1, live: false } }),
      ['!a:example.org']
    );
  });

  it('is not reported while the session is still working', () => {
    // The message may be queued: `_queueSteer`/`_queueFollowUp` hold it, and
    // pi's runLoop drains both queues inside the same run. Reporting here would
    // fire on every message that arrived mid-turn, which is most of them.
    assert.deepEqual(
      rooms({ '!a:example.org': { at: NOW - DELIVERY_GRACE_MS - 1, live: false } }, true),
      []
    );
  });

  it('is not reported before the grace has passed', () => {
    // `prompt()` awaits `_checkCompaction` BEFORE starting a run, so an idle
    // session can hold a message with nothing running and nothing consumed.
    assert.deepEqual(rooms({ '!a:example.org': { at: NOW - 1_000, live: false } }), []);
  });

  it('control — a message pi did take is never reported', () => {
    assert.deepEqual(rooms({ '!a:example.org': { at: NOW - DELIVERY_GRACE_MS - 1, live: true } }), []);
  });

  it('control — a message already reported is not reported again', () => {
    // The sweep runs on a timer; without this the sender gets the same sentence
    // every thirty seconds for as long as the entry survives.
    assert.deepEqual(
      rooms({
        '!a:example.org': { at: NOW - DELIVERY_GRACE_MS * 5, live: false, undeliveredReported: true },
      }),
      []
    );
  });

  it('reports every room that is waiting, not just the first', () => {
    // Unlike forwarding, which refuses to guess between two waiting rooms: this
    // is not an answer, it is news about their own message, so it is
    // attributable to each of them separately.
    assert.deepEqual(
      rooms({
        '!a:example.org': { at: NOW - DELIVERY_GRACE_MS - 1, live: false },
        '!b:example.org': { at: NOW - DELIVERY_GRACE_MS - 1, live: false },
        '!c:example.org': { at: NOW - DELIVERY_GRACE_MS - 1, live: true },
      }),
      ['!a:example.org', '!b:example.org']
    );
  });

  it('says to send it again, and does not invent a cause', () => {
    const text = undeliveredMessage();
    assert.match(text, /send it again/i);
    // pi swallowed the reason, so naming one would be a guess presented as fact.
    assert.match(text, /may have been|may be/i);
  });
});

describe('AB2 — the wiring', () => {
  const source = readFileSync(join(PACKAGE_ROOT, 'extensions', 'index.ts'), 'utf8');

  it('sweeps at the end of a run and on a timer', () => {
    // Two triggers, because the failure removes the first one: a message that
    // was refused never starts a run, so there may be no `agent_settled` at all.
    assert.match(source, /sweepUndelivered\(\);/);
    assert.match(source, /setInterval\(sweepUndelivered, DELIVERY_SWEEP_MS\)/);
  });

  it('arms the sweep when the message arrives, not when the send returns', () => {
    // Fourteenth pass (AE3): the entry is now folded into whatever the room
    // already had, rather than replacing it — see mergeAwaiting. The fact this
    // pins is unchanged: recorded first, watched second, sent third.
    const set = source.indexOf('awaitingReply.set(');
    const arm = source.indexOf('armDeliverySweep();');
    const send = source.indexOf('api.sendUserMessage(text,');

    assert.ok(set > 0 && arm > set, 'the entry is recorded and then watched');
    assert.ok(arm < send, '"the send succeeded" is not observable, so the watch cannot depend on it');
  });

  it('leaves the entry in place after reporting', () => {
    // So a late delivery — a compaction finishing, a server coming back — still
    // reaches `markLive` and the answer still goes to the room. The cost of a
    // wrong verdict is one extra sentence, never a lost answer.
    const sweep = source.slice(source.indexOf('function sweepUndelivered'));
    const body = sweep.slice(0, sweep.indexOf('\n}\n'));
    assert.doesNotMatch(body, /awaitingReply\.delete/);
    assert.match(body, /entry\.undeliveredReported = true;/);
  });
});

/**
 * AC4 — a message this extension answered itself is not one pi refused.
 *
 * Twelfth pass. AB2's rule reads the absence of `markLive` as "pi never took
 * it", which is sound for a message that was HANDED to pi. Two paths in
 * `deliverInbound` never hand one over, and both were reported anyway:
 *
 *   refuse   `/model gpt` from Matrix. The sender is sent the refusal and the
 *            message deliberately never reaches the model — "a refused command
 *            must not arrive as text for the model to be talked into running
 *            some other way".
 *   run      `/loop status` from Matrix. It IS executed, by pi's command
 *            dispatch, which returns before any turn: no user message, so
 *            nothing to echo, so `markLive` can never fire for it. The sender is
 *            told "Ran `/loop status`. Its output stays in the terminal."
 *
 * A minute later, both got "I could not hand that to the session … please send
 * it again" — about a message that was answered, inviting a re-send of a command
 * that will be refused again. §O of the hand-testing script calls a false
 * positive here worse than the bug, and it is: silence is ambiguous, a wrong
 * apology is a claim.
 *
 * See AC4 in `context/design/subagents-loop-verifier-deliveries.md`.
 */
describe('AC4 — a command this extension handled is not an undelivered message', () => {
  it('does not report a refused Matrix command', () => {
    assert.deepEqual(
      rooms({ '!a:example.org': { at: NOW - DELIVERY_GRACE_MS - 1, live: false, answered: true } }),
      []
    );
  });

  it('does not report a command that ran but produced no user message', () => {
    // The `run` path's entry is identical in every field the sweep reads: never
    // live, past the grace, session idle. Only `answered` tells them apart.
    assert.deepEqual(
      rooms({
        '!ran:example.org': { at: NOW - DELIVERY_GRACE_MS * 5, live: false, answered: true },
        '!lost:example.org': { at: NOW - DELIVERY_GRACE_MS * 5, live: false },
      }),
      ['!lost:example.org']
    );
  });

  it('control — an ordinary message pi never took is still reported', () => {
    assert.deepEqual(
      rooms({ '!a:example.org': { at: NOW - DELIVERY_GRACE_MS - 1, live: false, answered: false } }),
      ['!a:example.org']
    );
  });

  it('the two command paths set the flag the rule reads', () => {
    const source = readFileSync(join(PACKAGE_ROOT, 'extensions', 'index.ts'), 'utf8');
    // Both branches mark the entry before returning; the local branch (AC5) too.
    const marks = [...source.matchAll(/pending\.answered = true;/g)];
    assert.ok(marks.length >= 3, `expected the refuse, run and local branches to mark the entry, saw ${marks.length}`);
  });
});

/**
 * AE3 (fourteenth pass) — the room entry a second message used to destroy.
 *
 * `awaitingReply` is keyed by ROOM and holds one entry, and `deliverInbound`
 * `set()` a fresh one for every inbound message — including the ones this
 * extension answers itself. So a `/compact` sent by the same person who is
 * waiting for an answer replaced the entry for their own question, with
 * `live: false`, and nothing could ever set it again: a locally-performed
 * command produces no user message, so `markLive` has nothing to match.
 *
 * `live` is not a property of a message. It is evidence about the room — pi has
 * taken something from it and owes it an answer — and `forwardToMatrix` filters
 * on it precisely so an answer only reaches a room that is owed one. Clearing it
 * did not delay the answer, it deleted it, in silence: `answered: true`, set by
 * the local branch on the way past, kept the undelivered sweep quiet as well.
 *
 * Executed in `context/testing/probes/r3-…`, mode `same-room`: the sender asked
 * a question, then asked for a compaction, and the answer was never sent and
 * never reported.
 */
describe('mergeAwaiting', () => {
  const arrival = (over = {}) => ({
    messageId: '$new',
    injected: '[matrix] the new one',
    question: 'the new one',
    handedToPi: true,
    at: 2_000,
    ...over,
  });
  const live = {
    messageId: '$old',
    injected: '[matrix] the old one',
    question: 'the old one',
    at: 1_000,
    answered: false,
    live: true,
  };

  it('never takes `live` back down', () => {
    // The whole finding. A second message cannot un-take the first.
    assert.equal(mergeAwaiting(live, arrival()).live, true);
    assert.equal(mergeAwaiting(live, arrival({ handedToPi: false })).live, true);
  });

  it('a message pi was never given does not become the room\'s marker', () => {
    const merged = mergeAwaiting(live, arrival({ handedToPi: false, injected: '/compact', question: '/compact' }));
    assert.equal(merged.injected, '[matrix] the old one');
    assert.equal(merged.question, 'the old one');
    assert.equal(merged.messageId, '$old');
  });

  it('but a message pi WAS given does — that is what markLive matches next', () => {
    const merged = mergeAwaiting(live, arrival());
    assert.equal(merged.injected, '[matrix] the new one');
    assert.equal(merged.question, 'the new one');
    assert.equal(merged.messageId, '$new');
  });

  it('a new question is owed a reply again', () => {
    assert.equal(mergeAwaiting({ ...live, answered: true }, arrival()).answered, false);
  });

  it('…and a command this file performs itself does not make one owed', () => {
    assert.equal(mergeAwaiting({ ...live, answered: true }, arrival({ handedToPi: false })).answered, true);
  });

  it('carries the empty-turn retry count, which is per room and not per message', () => {
    assert.equal(mergeAwaiting({ ...live, emptyRetries: 1 }, arrival()).emptyRetries, 1);
  });

  it('drops undeliveredReported, so a new message gets a fresh verdict', () => {
    const merged = mergeAwaiting({ ...live, live: false, undeliveredReported: true }, arrival());
    assert.equal(merged.undeliveredReported, undefined);
    assert.deepEqual(undeliveredRooms([['!r', { ...merged, at: 0 }]], DELIVERY_GRACE_MS + 1, false), ['!r']);
  });

  it('control — the first message in a room is unchanged by any of this', () => {
    assert.deepEqual(mergeAwaiting(undefined, arrival()), {
      messageId: '$new',
      injected: '[matrix] the new one',
      question: 'the new one',
      at: 2_000,
      answered: false,
      live: false,
      emptyRetries: undefined,
    });
  });

  it('control — a local command with no previous entry still records the room', () => {
    // Nothing to preserve, so there is nothing to get wrong; the entry exists so
    // `answered` has somewhere to go.
    const merged = mergeAwaiting(undefined, arrival({ handedToPi: false }));
    assert.equal(merged.live, false);
    assert.equal(merged.messageId, '$new');
  });
});

/**
 * AE4 (fourteenth pass) — the continuation is evidenced, not claimed.
 *
 * `retrying` is set on the strength of having CALLED `api.sendUserMessage`, and
 * that call cannot report failure: it returns void and pi `.catch`es its own
 * rejection into `emitError`, whose listener set is empty outside a TUI — the
 * same fact this file's header is about, one direction over. `retrying` is what
 * suppresses the retirement of every LIVE room at the bottom of `forwardResult`,
 * so a continuation that never happened left the sender's room live and
 * unanswered, and the next unrelated turn's answer was forwarded to it.
 *
 * The repair is the mechanism that was already there: the room stands back down
 * until `markLive` fires for the nudge. A nudge pi never takes then leaves an
 * entry that is not live, not answered and past the grace on an idle session,
 * which is exactly what `undeliveredRooms` above reports.
 *
 * Executed in `context/testing/probes/r3-…`, mode `never-taken` (and
 * `PROBE_SLOW=1` to watch the sweep report it).
 */
describe('AE4 — the retry waits for the same evidence the first delivery did', () => {
  const source = readFileSync(join(PACKAGE_ROOT, 'extensions', 'index.ts'), 'utf8');
  const forward = source.slice(source.indexOf('async function forwardResult('));
  const body = forward.slice(0, forward.indexOf('\n}\n'));

  it('stands the room back down before sending the nudge', () => {
    assert.ok(body.includes('entry.live = false;'));
    assert.ok(body.includes('entry.injected = nudge;'));
  });

  it('and restarts the delivery clock, so the sweep measures the nudge', () => {
    assert.ok(body.includes('entry.at = Date.now();'));
    assert.ok(body.includes('entry.undeliveredReported = false;'));
  });

  it('the nudge is the string markLive will be asked to match', () => {
    const setAt = body.indexOf('entry.injected = nudge;');
    const sendAt = body.indexOf('api.sendUserMessage(nudge');
    assert.equal(setAt > 0 && sendAt > setAt, true);
  });

  it('control — an entry in exactly that state is what the sweep reports', () => {
    const entry = { at: 0, live: false, answered: false };
    assert.deepEqual(undeliveredRooms([['!r', entry]], DELIVERY_GRACE_MS + 1, false), ['!r']);
    // …and is silent while the session is still working on it.
    assert.deepEqual(undeliveredRooms([['!r', entry]], DELIVERY_GRACE_MS + 1, true), []);
  });
});

/**
 * AF1 — the answer two rooms were both owed.
 *
 * `forwardToMatrix` refuses to send when more than one room is live, and the
 * refusal is right: with two there is no way to tell whose answer this is, and
 * sending one person's conversation to another is not undoable. What was missing
 * is what happens to the two questions afterwards. `forwardResult` ends with
 *
 *     for (const [room, entry] of awaitingReply) {
 *       if (entry.live) awaitingReply.delete(room);
 *     }
 *
 * so both rooms were retired unanswered, and the entry that proved either
 * question had ever been asked went with them — which is also why
 * `undeliveredRooms` could not report it: there was nothing left to report on.
 * Two people, two questions, zero answers, zero notices, and one line in a log
 * file the operator is not watching.
 *
 * It is the ordinary case for a channel with two people on it. `deliverInbound`
 * queues each message as a follow-up; pi's agent loop drains the queue inside
 * the same run (`runLoop`'s outer while, `pi-agent-core/agent-loop.js`); both
 * are echoed back as user messages; `markLive` marks both.
 *
 * The fourteenth pass looked straight at this behaviour and read it as a
 * property of the PROBE — `r3`'s header explains that a leftover live room from
 * an earlier scenario suppresses the leak the next one is about — without asking
 * what it does in production.
 *
 * Measured end to end in
 * `context/testing/probes/s1-the-answer-two-rooms-were-both-owed.mjs`.
 *
 * See AF1 in `context/design/subagents-loop-verifier-omissions.md`.
 */
describe('AF1 — a live room retired with nothing sent for it', () => {
  const live = (over: Record<string, unknown> = {}) => ({ at: NOW, live: true, ...over });

  it('is what unansweredRooms names', () => {
    assert.deepEqual(
      unansweredRooms([
        ['!a', live()],
        ['!b', live()],
      ]),
      ['!a', '!b'],
      'both of them: neither got the answer, and neither knows',
    );
  });

  it('is not a room that has had something sent to it', () => {
    assert.deepEqual(unansweredRooms([['!a', live({ answered: true })]]), []);
  });

  it('is not a room pi never took a message from', () => {
    // That one is `undeliveredRooms`' business, and it stays in the map to be
    // swept — retiring it here would delete the evidence a second time.
    assert.deepEqual(unansweredRooms([['!a', { at: NOW, live: false }]]), []);
  });

  it('says which of the two things happened, and asks for what it needs', () => {
    const ambiguous = unansweredMessage('ambiguous');
    assert.match(ambiguous, /could not tell which reply was yours/);
    assert.match(ambiguous, /ask again/i);
    assert.doesNotMatch(ambiguous, /room|!/, 'nothing about the other conversation but that it existed');

    const nothing = unansweredMessage('nothing-to-send');
    assert.match(nothing, /anything I could send you/);
    assert.match(nothing, /ask again/i);
    assert.notEqual(ambiguous, nothing, 'two different facts, two different sentences');
  });
});

describe('AF1 — the wiring', () => {
  const source = readFileSync(join(PACKAGE_ROOT, 'extensions', 'index.ts'), 'utf8');
  const forward = source.slice(source.indexOf('async function forwardResult('));
  const body = forward.slice(0, forward.indexOf('\n}\n'));

  it('tells the rooms BEFORE it retires them', () => {
    const told = body.indexOf('unansweredRooms(awaitingReply.entries())');
    const retired = body.indexOf('awaitingReply.delete(room)');
    assert.ok(told > 0, 'the retirement asks who was left unanswered');
    assert.ok(told < retired, 'and asks while the entries still exist');
  });

  it('marks them answered, so the sweep does not report them a second time', () => {
    assert.match(body, /entry\.answered = true;[\s\S]*unansweredMessage\(reason\)/);
  });

  it('the give-up message counts as an answer too', () => {
    // It is something sent for that message, which is exactly what `answered`
    // means — and without it the retirement below would send a second sentence
    // on top of it.
    const giveUp = body.indexOf('giveUpMessage(detail)');
    const marked = body.indexOf('for (const [, entry] of waiting) entry.answered = true;');
    assert.ok(marked > 0 && marked < giveUp);
  });

  it('the ambiguity is remembered where the refusal happens', () => {
    const forwardTo = source.slice(source.indexOf('async function forwardToMatrix('));
    const fnBody = forwardTo.slice(0, forwardTo.indexOf('\n}\n'));
    assert.match(fnBody, /rooms\.length > 1[\s\S]*unattributableThisRun = true;/);
  });

  it('and forgotten at the end of the run it belongs to', () => {
    assert.match(body, /alreadySent\.clear\(\);\s*\n\s*unattributableThisRun = false;/);
  });
});

/**
 * AG3 — the continuation, and the compaction that was already running.
 *
 * `agent_settled` fires `pi-loop-mode`'s handler FIRST — which may call
 * `requestEmergencyCompaction` — and `prinny-channel`'s SECOND, which is where
 * the empty-turn continuation is sent from. pi's refusal
 * ("Cannot submit a prompt while compaction is in progress") is on
 * `AgentSession.prompt()`, which `sendUserMessage` reaches, and it is a throw
 * into a promise pi `.catch`es into `emitError` — an empty listener set outside a
 * TUI. So the nudge went nowhere, silently, while `emptyRetries` was charged for
 * it.
 *
 * The two conditions are correlated rather than independent: the loop's
 * starvation rung fires on a clean "stop" with no answer at >= 80% of the
 * window, and `describeEmptyEnding`'s `context` reason is >= 87%. One empty turn
 * on a saturated context produces both.
 *
 * `startCompaction`, twelve lines away in the same file, has read
 * `compactionInFlight()` since the fifteenth pass. This was the other sender.
 *
 * Driven end to end, with both real extensions in one process, in
 * `context/testing/probes/t1-the-nudge-and-the-compaction-already-running.mjs`.
 */
describe('AG3 — a continuation is not sent into a running compaction', () => {
  const source = readFileSync(join(PACKAGE_ROOT, 'extensions', 'index.ts'), 'utf8');
  const forward = source.slice(source.indexOf('async function forwardResult('));
  const body = forward.slice(0, forward.indexOf('\n}\n'));

  it('the lock is read before the continuation is even considered', () => {
    const read = body.indexOf('compactionInFlight()');
    const send = body.indexOf("api.sendUserMessage(nudge");
    assert.ok(read > 0, 'forwardResult must ask who is compacting');
    assert.ok(read < send, 'and ask before it sends, not after');
  });

  it('and the retry budget is not charged for a send that cannot happen', () => {
    const guard = body.indexOf('!heldForCompaction');
    const charge = body.indexOf('entry.emptyRetries = (entry.emptyRetries ?? 0) + 1');
    assert.ok(guard > 0 && guard < charge, 'the guard has to be outside the block that spends a retry');
  });

  it('the held room is retired with a reason, not left live and silent', () => {
    // An entry that is live and unanswered is invisible to `undeliveredRooms`,
    // so leaving it would trade a wasted retry for silence.
    assert.match(body, /heldForCompaction\s*\n?\s*\?\s*'compacting'/);
    const retired = body.indexOf('awaitingReply.delete(room)');
    const told = body.indexOf('unansweredMessage(reason)');
    assert.ok(told > 0 && told < retired);
  });

  it('holding is not the same as continuing — a waiting /compact must not stand aside for it', () => {
    // `retrying` is returned as `continuationStarted` and feeds standAside
    // (AE2). Nothing started, so nothing should wait for it.
    assert.match(body, /let heldForCompaction = false;/);
    assert.doesNotMatch(body, /heldForCompaction = true;\s*\n\s*retrying = true;/);
    assert.match(forward.slice(0, forward.indexOf('\n}\n')), /return retrying;/);
  });

  it('the sender is told the true reason rather than the sweep’s guess', () => {
    const held = unansweredMessage('compacting');
    assert.match(held, /compacting/);
    assert.match(held, /ask again/i);
    assert.notEqual(held, unansweredMessage('nothing-to-send'));
    assert.notEqual(held, unansweredMessage('ambiguous'));
    // The sweep's sentence hedges — "it MAY have been compacting" — because it
    // has no observable. This one is chosen with the lock in hand.
    assert.doesNotMatch(held, /may have been/);
  });
});
