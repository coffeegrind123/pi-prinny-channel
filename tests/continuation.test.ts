/**
 * Getting an answer out of a run that ended without one.
 *
 * The guard in forwarding.ts stops an empty turn being answered with the
 * previous turn's deliberation, and reports it. Reporting is not answering: from
 * the sender's side "I did not manage to answer that" is still no news, and a
 * question could simply never complete. So the run is continued.
 */

import { describe, expect, it } from './harness.ts';
import {
  MAX_EMPTY_RETRIES,
  MAX_QUESTION_CHARS,
  giveUpMessage,
  nudgeForEmptyEnding,
  shouldRetryEmptyTurn,
} from '../src/continuation.ts';

describe('shouldRetryEmptyTurn', () => {
  it('allows a bounded number of attempts', () => {
    expect(shouldRetryEmptyTurn(0)).toBe(true);
    expect(shouldRetryEmptyTurn(MAX_EMPTY_RETRIES - 1)).toBe(true);
  });

  it('stops rather than grinding', () => {
    // A nudge that fails the same way twice will fail the same way forever, and
    // each attempt costs a full turn against a window that may be the problem.
    expect(shouldRetryEmptyTurn(MAX_EMPTY_RETRIES)).toBe(false);
    expect(shouldRetryEmptyTurn(MAX_EMPTY_RETRIES + 5)).toBe(false);
  });

  it('is bounded low enough that a stuck run cannot spin', () => {
    expect(MAX_EMPTY_RETRIES < 4).toBe(true);
  });

  it('treats a nonsense count as spent rather than as zero', () => {
    expect(shouldRetryEmptyTurn(Number.NaN)).toBe(false);
    expect(shouldRetryEmptyTurn(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('nudgeForEmptyEnding', () => {
  it('tells a model that generated tokens to answer, not that it ran out of room', () => {
    // The 43%-of-window case: 126 output tokens, no answer. Telling it the
    // context was full would be the same mistake the first warning made.
    const text = nudgeForEmptyEnding('produced-no-answer');
    expect(text).toContain('produced no answer');
    expect(text).not.toContain('context');
  });

  it('tells a starved model to answer briefly and read nothing more', () => {
    const text = nudgeForEmptyEnding('context');
    expect(text).toContain('ran out of context');
    expect(text).toContain('Do not read anything further');
  });

  it('explains nothing on a transport failure, because it never got to think', () => {
    const text = nudgeForEmptyEnding('error');
    expect(text).toContain('failed before it finished');
  });

  it('always forbids more tool calls — that is how the last turn got here', () => {
    for (const reason of ['produced-no-answer', 'context', 'error', 'unknown'] as const) {
      const text = nudgeForEmptyEnding(reason);
      expect(text.toLowerCase()).toContain('answer');
      if (reason !== 'error') expect(text.toLowerCase()).toContain('not call any more tools');
    }
  });

  it('stays short, because it is spent from the window that may be the problem', () => {
    for (const reason of ['produced-no-answer', 'context', 'error', 'unknown'] as const) {
      expect(nudgeForEmptyEnding(reason).length < 300).toBe(true);
    }
  });

  it('carries the question, so a compaction cannot lose what was asked', () => {
    // The failure this closes: an empty turn is often a turn that has just
    // compacted, and the summary is written by the same model that is not
    // answering. "Answer the outstanding question" can arrive in a context where
    // the question is gone.
    const text = nudgeForEmptyEnding('produced-no-answer', 'dive into the watermark thing');
    expect(text).toContain('dive into the watermark thing');
    expect(text).toContain('The question was');
  });

  it('bounds the question, because a sender chose it', () => {
    const huge = 'x'.repeat(5_000);
    const text = nudgeForEmptyEnding('context', huge);
    expect(text.length < MAX_QUESTION_CHARS + 400).toBe(true);
    expect(text).toContain('…');
  });

  it('collapses whitespace so a multi-line question stays one line', () => {
    const text = nudgeForEmptyEnding('unknown', 'line one\n\n   line two');
    expect(text).toContain('line one line two');
  });

  it('says nothing extra when there is no question to restate', () => {
    expect(nudgeForEmptyEnding('error')).not.toContain('The question was');
    expect(nudgeForEmptyEnding('error', '   ')).not.toContain('The question was');
  });
});

describe('giveUpMessage', () => {
  it('says what happened and that it was retried', () => {
    const text = giveUpMessage('the model generated 126 tokens but none of them were an answer');
    expect(text).toContain('126 tokens');
    expect(text).toContain('tried again');
    expect(text).toContain('Ask again');
  });
});
