/**
 * Who should be seeing a typing indicator, and who should stop.
 *
 * Kept out of `extensions/index.ts` for the usual reason — that file imports
 * pi's own packages and typebox, which do not resolve under `node --test`, so
 * anything importing it is untestable. The reconciliation is the part with rules
 * worth pinning.
 *
 * ## Why this exists at all
 *
 * The sidecar sets typing when a message arrives, and Matrix expires it on its
 * own timeout — 20 seconds by default. A local 27B model routinely thinks for
 * longer than that, so the indicator lapsed mid-thought and the sender saw a bot
 * that had gone quiet at exactly the moment the signal was meant to be saying
 * "still working". Keeping it alive means re-sending it on a period shorter than
 * the timeout being asked for.
 *
 * ## Why it reconciles rather than toggles
 *
 * A turn can have more than one room waiting, and they do not finish together.
 * Deriving the whole desired set from `awaitingReply` each tick means a room
 * answered mid-turn stops while the others carry on, and — more importantly — an
 * indicator cannot outlive the state that justified it. A stuck typing indicator
 * is the classic bot bug, and the only reliable fix is to not depend on the
 * happy path having run.
 */

/** What must change to bring the indicator in line with who is waiting. */
export interface TypingPlan {
  /** Rooms to send `typing: true` to — including refreshes for rooms already active. */
  start: string[];
  /** Rooms to send `typing: false` to, because they are no longer waiting. */
  stop: string[];
}

/**
 * Diff the rooms that should be typing against the rooms that currently are.
 *
 * `start` deliberately includes rooms already in `active`: re-sending is the
 * refresh, and treating it as a no-op is how the indicator silently expires
 * halfway through a long turn.
 */
export function planTyping(waiting: readonly string[], active: ReadonlySet<string>): TypingPlan {
  const wanted = new Set(waiting.filter((room) => typeof room === 'string' && room));
  return {
    start: [...wanted],
    stop: [...active].filter((room) => !wanted.has(room)),
  };
}

/** Every active room, for the end of a turn or a shutdown — state-independent on purpose. */
export function planStopAll(active: ReadonlySet<string>): TypingPlan {
  return { start: [], stop: [...active] };
}
