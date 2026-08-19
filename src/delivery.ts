/**
 * Which inbound messages pi never took, and what to say about them.
 *
 * ## The hole this fills
 *
 * `deliverInbound` hands a Matrix message to the session with
 * `api.sendUserMessage(text, { deliverAs })`, inside a `try`/`catch`. That catch
 * is very nearly decorative. `ExtensionAPI.sendUserMessage` returns `void`, and
 * pi's own binding is:
 *
 * ```js
 *   sendUserMessage: (content, options) => {
 *     this.sendUserMessage(content, options).catch((err) => {
 *       runner.emitError({ extensionPath: "<runtime>", event: "send_user_message", … });
 *     });
 *   },                                       // agent-session.js:1855
 * ```
 *
 * so every asynchronous failure is caught by pi and turned into an extension
 * error, and `emitError` fans out to `runner.errorListeners` — a set with exactly
 * one possible member, `agent-session.js:1809`, registered only when a UI has
 * bound one. Outside a TUI there is nobody in it and the error is gone. Nothing
 * in the extension API lets an extension subscribe: there is no error event in
 * `ExtensionEvent`.
 *
 * What can fail is not exotic. `AgentSession.prompt()` throws when a compaction
 * is in progress (`agent-session.js:805` — and `AgentSession.compact()` holds
 * `_compactionAbortController` for its whole duration, which `/loop`'s stuck
 * ladder and its context recovery both enter), when no model is selected, and
 * when the provider has no usable auth. On this stack that last one is "the
 * llama-server is down", which is a state a Matrix user has no way to see.
 *
 * The result was silence. The room went into `awaitingReply` on arrival, was
 * never marked live because pi never consumed anything, so it was never answered,
 * never retired, and never reported. From Matrix it is indistinguishable from
 * being ignored — the exact failure the empty-turn continuation was written to
 * prevent, one layer further out.
 *
 * ## What is used as evidence instead
 *
 * The same evidence `markLive` already uses, read the other way round: a room
 * becomes live when pi echoes its message back as a `user` message, i.e. when pi
 * has actually taken it. So an entry that is still not live once the session is
 * idle and enough time has passed was not taken.
 *
 * Idleness is the load-bearing half, not the clock. A message delivered while pi
 * is streaming is queued (`_queueSteer`/`_queueFollowUp`) and drains inside that
 * same run — pi's `runLoop` has an inner while for steering and an outer while
 * for follow-ups, and `_handlePostAgentRun` runs `agent.continue()` for anything
 * queued after `agent_end` — so it is live before `agent_settled` fires. Waiting
 * for idle therefore costs nothing in the normal case and removes the whole class
 * of "it was just busy" false positives.
 *
 * The clock is there for the one thing idleness cannot cover: `prompt()` awaits
 * `_checkCompaction` BEFORE it starts a run, so a message delivered to an idle
 * session can sit for as long as an auto-compaction takes with nothing running
 * and nothing consumed. A minute is comfortably more than that on this box and
 * comfortably less than a person's patience.
 *
 * ## Why it reports rather than retries or retires
 *
 * The entry is left in place. If pi does take the message after all — a late
 * compaction finishing, an operator restarting the server — `markLive` still
 * fires and the answer still reaches the room. So the worst case of a wrong
 * verdict is one extra sentence, never a lost answer. Re-sending it instead
 * would risk asking the model the same question twice, which is worse than
 * saying "I could not hand that over".
 */

export interface DeliveryEntry {
  at: number;
  live: boolean;
  undeliveredReported?: boolean;
  /**
   * This extension has already dealt with the message itself, so pi was never
   * meant to see it.
   *
   * Twelfth pass (AC4). `live` answers "did pi take this", and the sweep below
   * reads its absence as "pi refused it" — which is true for a message that was
   * HANDED to pi. Two paths in `deliverInbound` never hand one over: a Matrix
   * `/command` that is refused (the sender is sent the refusal instead) and one
   * that is allowed (it is executed, and the sender is told it ran). Both set
   * this flag, both leave `live` false forever, and both were therefore reported
   * a minute later as "I could not hand that to the session … please send it
   * again" — about a message that was answered, inviting a re-send of a command
   * that will be refused again.
   *
   * A false positive here is worse than the silence AB2 fixed: it tells somebody
   * their message was lost when it was not. So the rule asks two questions now —
   * did pi take it, and was it ever pi's to take.
   */
  answered?: boolean;
}

/**
 * The whole of what a room's pending entry holds. `DeliveryEntry` above is the
 * slice the sweep reads; this is the slice {@link mergeAwaiting} owns.
 */
export interface AwaitingEntry extends DeliveryEntry {
  messageId?: string;
  injected?: string;
  question?: string;
  emptyRetries?: number;
}

/** The fields a newly arrived message brings, plus what this file did with it. */
export interface InboundArrival {
  messageId?: string;
  /** Exactly what was handed to pi, which is what `markLive` matches on. */
  injected: string;
  /** What was actually asked, for a continuation that has to survive a compaction. */
  question: string;
  /** True when the message was handed to pi. False for a refused or locally-performed command. */
  handedToPi: boolean;
  at: number;
}

/**
 * Fold a newly arrived message into the room's pending entry.
 *
 * Fourteenth pass (AE3). `awaitingReply` is a Map keyed by ROOM and holds ONE
 * entry, and `deliverInbound` used to `set()` a fresh one unconditionally. So a
 * second message from the same room — including one this extension answers
 * ITSELF, which is `/compact`, a refused command, or an allowed one — replaced
 * the entry belonging to the question the model was still working on, with
 * `live: false`.
 *
 * `live` is not a property of a message. It is evidence about the ROOM: pi has
 * taken something from it and owes it an answer, and `forwardToMatrix` filters
 * on it precisely so that an answer only ever goes to a room that is owed one.
 * Clearing it therefore did not delay the answer, it DELETED it — the reply
 * arrived at `agent_settled`, found no live room, and was dropped in silence.
 * And because the second message set `answered = true` on the way past, the
 * undelivered sweep could not report the first one either.
 *
 * Nothing else could restore it: a locally-performed command produces no user
 * message, so `markLive` can never fire for it. Measured in
 * `context/testing/probes/r3-the-compaction-that-cancels-its-own-continuation.mjs`,
 * mode `same-room`: the sender asked a question, then asked for a compaction, and
 * the answer to the question was never sent and never reported.
 *
 * Two rules, and both are about not throwing evidence away:
 *
 *   · **`live` only ever goes up.** A second message cannot un-take the first.
 *   · **A message that was never pi's to take does not become the room's
 *     marker.** `injected`, `messageId` and `question` describe what pi is
 *     answering; a `/compact` is not that, and overwriting them would leave
 *     `markLive` matching a string pi will never emit and the continuation
 *     restating "/compact" as the question.
 *
 * `undeliveredReported` is deliberately dropped: a new message deserves a fresh
 * verdict, and the sweep marks itself again if it is still right.
 */
export function mergeAwaiting(previous: AwaitingEntry | undefined, arrival: InboundArrival): AwaitingEntry {
  return {
    messageId: arrival.handedToPi ? arrival.messageId : (previous?.messageId ?? arrival.messageId),
    injected: arrival.handedToPi ? arrival.injected : previous?.injected,
    question: arrival.handedToPi ? arrival.question : previous?.question,
    at: arrival.at,
    // A new question is owed a reply; a command this file performs itself does
    // not change whether the earlier one has been answered.
    answered: arrival.handedToPi ? false : (previous?.answered ?? false),
    live: previous?.live === true,
    emptyRetries: previous?.emptyRetries,
  };
}

/**
 * How long a message may sit unconsumed on an IDLE session before it is treated
 * as never delivered. Covers `prompt()`'s pre-run compaction; see the header.
 */
export const DELIVERY_GRACE_MS = 60_000;

/**
 * The rooms whose message pi never took.
 *
 * `agentRunning` is passed in rather than read, because the caller is the only
 * thing that knows it and because it makes the rule testable without a session.
 */
export function undeliveredRooms<T extends DeliveryEntry>(
  entries: Iterable<[string, T]>,
  now: number,
  agentRunning: boolean,
  graceMs: number = DELIVERY_GRACE_MS
): string[] {
  if (agentRunning) return [];
  const rooms: string[] = [];
  for (const [room, entry] of entries) {
    // `answered` first, because it is the question that makes the others
    // meaningful: an entry this extension resolved itself was never handed to
    // pi, so pi not having taken it is not evidence of anything. See AC4 on
    // DeliveryEntry.answered.
    if (entry.answered || entry.live || entry.undeliveredReported) continue;
    if (now - entry.at < graceMs) continue;
    rooms.push(room);
  }
  return rooms;
}

/**
 * Why a room that pi DID take a message from is being retired with nothing sent.
 *
 * `ambiguous` — more than one room was live when the answer arrived, so
 * `forwardToMatrix` refused to guess which of them it belonged to.
 * `compacting` — the run ended without an answer and another extension was
 * already compacting the session, so the continuation that would have got one
 * could not be sent. See AG3.
 * `nothing-to-send` — everything else: the turn produced no text this channel
 * could forward, or forwarding is off and the model never called the tool.
 */
export type UnansweredReason = 'ambiguous' | 'compacting' | 'nothing-to-send';

/**
 * The rooms about to be retired with nothing having been sent for them.
 *
 * Fifteenth pass (AF1). `forwardResult` ends with
 *
 *     for (const [room, entry] of awaitingReply) {
 *       if (entry.live) awaitingReply.delete(room);
 *     }
 *
 * and `forwardToMatrix` returns early — correctly — when more than one room is
 * live, because with two there is no way to tell whose answer this is. Those two
 * facts together are a lost question: the refusal is right and the retirement
 * then throws the evidence away, so the sender is never told, the operator sees
 * one line in a log file nobody is watching, and `undeliveredRooms` above cannot
 * report it either because the entry is gone.
 *
 * Two people messaging in the same window is the ordinary case for a channel
 * with two people on it — one in a DM and one in a room is enough — and pi
 * consumes both in one run: `deliverInbound` queues each as a follow-up, pi's
 * agent loop drains the queue inside the same run, both are echoed back as user
 * messages, and `markLive` marks both.
 *
 * `answered` is the same flag the sweep reads, and for the same reason: a room
 * that has had a reply, a refusal, a receipt or a give-up message sent to it has
 * been answered, whatever the answer said.
 */
export function unansweredRooms<T extends DeliveryEntry>(entries: Iterable<[string, T]>): string[] {
  const rooms: string[] = [];
  for (const [room, entry] of entries) {
    if (!entry.live) continue;
    if (entry.answered) continue;
    rooms.push(room);
  }
  return rooms;
}

/**
 * What a sender is told when the run ended and nothing was sent to them.
 *
 * Two sentences, because they are two different facts and the second person is
 * owed the true one. Neither invents an answer, and both end in the only action
 * that is always available: ask again.
 *
 * The `ambiguous` case deliberately says that somebody else was being answered.
 * It is the one thing that explains the silence, it leaks nothing about who or
 * what — and without it the sentence would read as a malfunction rather than as
 * the deliberate refusal it is.
 */
export function unansweredMessage(reason: UnansweredReason): string {
  if (reason === 'ambiguous') {
    return (
      'Someone else was being answered in the same turn and I could not tell which reply was yours, ' +
      'so I sent nothing rather than send you theirs. Please ask again.'
    );
  }
  // AG3. Said now rather than left to the undelivered sweep a minute later, and
  // said as a fact rather than as the sweep's honest guess ("it may have been
  // compacting"): at the moment this is chosen the extension has read the lock
  // and knows.
  if (reason === 'compacting') {
    return (
      'That turn ended without an answer, and the session was already compacting its context, ' +
      'so I could not ask it again just then. Nothing is waiting on my side; please ask again in a moment.'
    );
  }
  return 'That turn finished without anything I could send you. Nothing is waiting on my side; please ask again.';
}

/**
 * What the sender is told.
 *
 * Says what is known and no more. The extension cannot tell a compaction from a
 * dead provider — pi swallowed the reason — so naming a cause would be an
 * invention, and "send it again" is the only action that is always right.
 */
export function undeliveredMessage(): string {
  return (
    'I could not hand that to the session — it would not accept a new message just then ' +
    '(it may have been compacting, or the model may be unavailable). ' +
    'Nothing was lost on my side; please send it again.'
  );
}
