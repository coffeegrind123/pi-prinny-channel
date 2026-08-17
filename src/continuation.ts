/**
 * Getting an answer out of a run that ended without one.
 *
 * A Matrix sender asked a question and the run settled with `content: []`. The
 * guard in `forwarding.ts` stops that being answered with the previous turn's
 * deliberation, and reports it — but reporting is not answering, and from the
 * sender's side "I did not manage to answer that" is still no news.
 *
 * So the run is continued rather than abandoned: one short prompt back into the
 * same session, aimed at the specific way it failed, and the ordinary forwarding
 * path delivers whatever comes out. The alternative — leaving it — means a
 * question can simply never complete, which is the thing being fixed.
 *
 * ## Why it is bounded, and bounded low
 *
 * A nudge that fails the same way twice will fail the same way forever, and each
 * attempt costs a full turn against a window that may already be the problem.
 * Two attempts is enough to get past a transport blip or a single thought-only
 * turn, and few enough that a genuinely stuck run stops rather than grinding.
 *
 * ## Why the wording differs by cause
 *
 * The three observed endings need different things said. A model that generated
 * 126 tokens and emitted no answer does not need to be told it ran out of room —
 * it needs to be told to answer. A request that died in transport needs nothing
 * explained at all, only retrying. Telling all three the same thing is what the
 * first version of the warning did, and it was wrong two times in three.
 *
 * Every nudge tells it NOT to call more tools. The sender is waiting on an
 * answer, and another round of tool calls is how the previous turn arrived here.
 *
 * ## Why the question is repeated back
 *
 * A run that ends empty is often a run that has just compacted, or is about to.
 * Compaction replaces the older messages with a summary, and the summary is
 * written by the same model that has just demonstrated it is not answering — so
 * "answer the outstanding question" can arrive in a context where the question
 * itself is gone. Carrying it in the nudge makes the continuation independent of
 * what survived, which is the difference between a task that eventually
 * completes and one that quietly cannot.
 *
 * Bounded, because it is spent from the window that may be the problem, and
 * because the question came from outside: a sender who writes a very long
 * message must not be able to make every retry enormous.
 */

/** Attempts to rescue one inbound message before giving up. */
export const MAX_EMPTY_RETRIES = 2;

/** How much of the original question a nudge may carry. */
export const MAX_QUESTION_CHARS = 400;

/** Endings worth another attempt. All of them, for now — with different words. */
export type EmptyReason = 'error' | 'truncated' | 'produced-no-answer' | 'context' | 'unknown';

/** Is another attempt allowed for this message? */
export function shouldRetryEmptyTurn(attemptsSoFar: number): boolean {
  return Number.isFinite(attemptsSoFar) && attemptsSoFar < MAX_EMPTY_RETRIES;
}

/**
 * The prompt sent back into the session, kept short on purpose.
 *
 * It is spent from the same window that may have caused the failure, so it says
 * one thing.
 */
export function nudgeForEmptyEnding(reason: EmptyReason, question?: string): string {
  const asked = typeof question === 'string' ? question.replace(/\s+/g, ' ').trim() : '';
  const restated = asked
    ? ` The question was: "${asked.length > MAX_QUESTION_CHARS ? `${asked.slice(0, MAX_QUESTION_CHARS)}…` : asked}"`
    : '';
  return `${baseNudge(reason)}${restated}`;
}

function baseNudge(reason: EmptyReason): string {
  switch (reason) {
    case 'produced-no-answer':
      // The 43%-of-window case: it generated tokens, none of which were an
      // answer. Nothing is wrong with the context; it just did not speak.
      return (
        'Your last turn produced no answer. Answer the outstanding question now, ' +
        'in plain text, using what you already have. Do not call any more tools.'
      );
    case 'context':
      return (
        'You ran out of context before answering. Answer the outstanding question now, ' +
        'briefly, from what you already have. Do not read anything further and do not call any more tools.'
      );
    case 'truncated':
      // It was mid-answer when the cap hit, so it has the material — it needs to
      // be shorter, not to start again.
      return (
        'Your last turn was cut off before you finished. Give the answer again, ' +
        'complete but much shorter, in plain text. Do not call any more tools.'
      );
    case 'error':
      // A transport failure. Nothing to explain — it never got to think.
      return 'The previous request failed before it finished. Answer the outstanding question now, in plain text.';
    default:
      return (
        'Your last turn ended without an answer. Answer the outstanding question now, ' +
        'in plain text. Do not call any more tools.'
      );
  }
}

/** What the sender is told once the attempts are spent. */
export function giveUpMessage(detail: string): string {
  return `I could not answer that — ${detail}. I tried again and still could not. Ask again, or narrow it down.`;
}
