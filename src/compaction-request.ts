/**
 * When a Matrix `/compact` may run, and what the sender is told meanwhile.
 *
 * ## Why this is a module and not three lines in the handler
 *
 * AC5 (twelfth pass) made `/compact` from Matrix real: the command had been
 * inert — pi's `prompt()` dispatches EXTENSION commands only, so the text
 * reached the model — and `prinny-channel` now performs it itself through
 * `ExtensionContext.compact({onComplete,onError})`.
 *
 * What that call does was not checked. pi's own implementation begins:
 *
 * ```js
 *   async compact(customInstructions) {
 *       await this.abort();               // dist/core/agent-session.js:1367
 * ```
 *
 * so the first thing a remote `/compact` does is cancel whatever the session was
 * doing — from a phone, with the command advertised in the client's own `/`
 * menu, in an extension whose every other inbound path is built not to do that
 * (`deliverAs: "followUp"` by default, under a comment saying "a message
 * arriving mid-turn joins the queue rather than interrupting work the user asked
 * for in the terminal").
 *
 * The damage is not confined to a lost turn. `vendor/pi-loop-mode`'s `agent_end`
 * ladder has a branch for an aborted turn and it PAUSES the run — "Loop paused
 * (turn aborted). Use /loop resume to continue", recorded as `Turn aborted by
 * operator`. So a remote `/compact` stopped an unattended run and attributed it
 * to somebody who was not there.
 *
 * ## Deferred, not refused
 *
 * The sender asked for something reasonable, and usually asked because the bot
 * had gone slow — "no" is the wrong answer when "in a moment" is available. So a
 * request that arrives mid-turn waits for `agent_settled`, which is where
 * `agentRunning` is cleared anyway, and by then aborting costs nothing because
 * the run is over.
 *
 * The decision lives here rather than in `extensions/index.ts` for the reason
 * `delivery.ts`, `record-activity.ts` and `concurrency-slots.ts` all exist: that
 * file imports pi and the suite cannot load it, so a rule written there can only
 * ever be pinned as text. See AD3 in
 * `context/design/subagents-loop-verifier-controls.md`.
 */

export type CompactionPlan =
  /** Start it now: nothing is in flight to cancel. */
  | { action: 'now' }
  /** Hold it until `agent_settled`; the sender is told which it was. */
  | { action: 'defer'; reply: string }
  /** There is no session to compact yet. */
  | { action: 'unavailable'; reply: string };

export interface CompactionInput {
  /** Whether a session context has been captured (session_start has happened). */
  hasSession: boolean;
  /** Whether an agent run is in flight — the same flag the typing indicator uses. */
  agentRunning: boolean;
}

/**
 * What to do with a `/compact` that just arrived from Matrix.
 *
 * Ordered so the answer is about the most specific thing that is wrong:
 * "no session" is a different sentence from "not right now", and telling
 * somebody to wait for a turn that does not exist is worse than either.
 */
export function planCompaction(input: CompactionInput): CompactionPlan {
  if (!input.hasSession) {
    return {
      action: 'unavailable',
      reply: 'I cannot compact yet — no session is open. Try again once the session is running.',
    };
  }
  if (input.agentRunning) {
    return {
      action: 'defer',
      reply: 'The session is mid-turn — I will compact as soon as it finishes rather than cutting it off.',
    };
  }
  return { action: 'now' };
}

/**
 * How many settlements a waiting `/compact` may stand aside for a continuation.
 *
 * Two, matching `MAX_EMPTY_RETRIES` in `continuation.ts`, because that is the
 * exact thing it is standing aside for: once the retries are spent there is no
 * further run to protect, and a compaction that could be starved indefinitely
 * would be a worse answer to the sender than a slightly late one.
 */
export const COMPACTION_DEFER_LIMIT = 2;

export interface PendingCompaction {
  room: string;
  at: number;
  /** Settlements this request has already let pass. See standAside. */
  stoodAside?: number;
}

/**
 * May the waiting compaction run now, or must it let a continuation go first?
 *
 * Fourteenth pass (AE2). AD3's whole argument for deferring to `agent_settled`
 * is one sentence — *"by then aborting costs nothing because the run is over"* —
 * and it is true of the run that just ended and false of the one the same
 * handler starts one line earlier:
 *
 * ```
 *   agentRunning = false
 *   stopTyping()
 *   await forwardResult()      ← the empty-turn continuation is sent from here
 *   drainPendingCompaction()   ← and pi's compact() begins `await this.abort()`
 * ```
 *
 * `continuation.ts` states the same premise from the other side — "a follow-up,
 * not a steer: nothing is in flight at `agent_settled`" — so two modules agree
 * about a moment and the first of them falsifies it for the second.
 *
 * The two conditions are correlated rather than independent, which is what makes
 * this reachable: a sender asks for a compaction BECAUSE the bot has gone quiet,
 * and an empty ending is what quiet looks like from inside — `describeEmptyEnding`'s
 * `context` reason is a window at 87% or more, which is the state a compaction is
 * for. Measured in
 * `context/testing/probes/r3-the-compaction-that-cancels-its-own-continuation.mjs`,
 * mode `settling-together`.
 *
 * Bounded rather than unconditional: if the continuation never actually starts —
 * `sendUserMessage` returns void and pi swallows its own rejection, which is
 * AE4 — an unbounded stand-aside would leave the request waiting for a run that
 * is not coming, and the sender was told it would happen "as soon as it
 * finishes".
 */
export function standAside(
  pending: PendingCompaction | undefined,
  continuationStarted: boolean,
): { wait: true; pending: PendingCompaction } | { wait: false } {
  if (!pending || !continuationStarted) return { wait: false };
  const stoodAside = pending.stoodAside ?? 0;
  if (stoodAside >= COMPACTION_DEFER_LIMIT) return { wait: false };
  return { wait: true, pending: { ...pending, stoodAside: stoodAside + 1 } };
}
