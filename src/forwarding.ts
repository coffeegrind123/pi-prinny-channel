/**
 * Deciding what of the assistant's output reaches Matrix.
 *
 * Kept out of `extensions/index.ts` so it can be tested. The extension imports
 * `typebox` and pi's own packages, which resolve against pi's module root and
 * are simply not there under `node --test` — so anything importing the
 * extension is untestable, and this is the part that most needs testing.
 */

/**
 * The plain text of one assistant message — nothing else.
 *
 * This is the filter that decides what a stranger on Matrix sees, and it is an
 * **allowlist** on purpose. An assistant message's content array mixes `text`,
 * `thinking` and `toolCall` blocks; only `text` is anybody's answer. Excluding
 * the other two by name would forward whatever kind pi adds next — which, for a
 * reasoning model, is exactly the content you least want relayed to somebody's
 * phone.
 *
 * Typed structurally rather than against `AgentMessage`, which pi does not
 * re-export, and defensively: a malformed block must not throw in the middle of
 * delivering somebody's answer.
 */
export function assistantTextOfMessage(message: unknown): string {
  const value = message as { role?: unknown; content?: unknown } | undefined;
  if (!value || value.role !== 'assistant') return '';
  const content = value.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        !!part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** Why a run ended with the model saying nothing, as far as the record shows. */
export type EmptyEnding =
  | { empty: false }
  | { empty: true; reason: 'error'; detail: string }
  | { empty: true; reason: 'truncated'; detail: string }
  | { empty: true; reason: 'produced-no-answer'; detail: string }
  | { empty: true; reason: 'context'; detail: string }
  | { empty: true; reason: 'unknown'; detail: string };

/**
 * Did the run end with the model producing nothing, and if so on what evidence?
 *
 * `content: []` on the final assistant message — no text, no thinking, no tool
 * call. pi reads that as a clean successful turn and settles the run, but there
 * is no answer to send.
 *
 * The REASON matters, because an earlier version of this asserted one cause for
 * all of them ("the context filled up") and was then watched being wrong. Three
 * distinct endings have now been observed on this stack, and they want different
 * responses:
 *
 *   context             out: 1 at 99% of the window. The documented cliff — 33
 *                       empty turns of 63 at or above 87%, against 3 of 196
 *                       below it.
 *   produced-no-answer  out: 126 at 43% of the window, stopReason "stop",
 *                       content []. The model generated over a hundred tokens
 *                       and none of them became an answer. Nothing to do with
 *                       room; on a reasoning model the likely reading is that it
 *                       thought and then stopped, but this only claims what the
 *                       record shows.
 *   error               stopReason "error", zero tokens either way. A stream
 *                       that ended without a finish_reason. A transport failure,
 *                       not the model declining to speak.
 *
 * Distinguished from a tool-call-only tail, which is a normal way for a run to
 * end and DOES have content — see `finalAssistantText`.
 */
export function describeEmptyEnding(
  messages: readonly unknown[],
  contextPercent?: number | null
): EmptyEnding {
  // Fourteenth pass (AE7): whether the walk has already passed an assistant
  // message with nothing in it. It decides what a `user` boundary means — see
  // the `break` below — and nothing else.
  let sawEmptyTail = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index] as
      | { role?: unknown; content?: unknown; stopReason?: unknown; usage?: { output?: unknown }; errorMessage?: unknown }
      | undefined;
    // Forge fork (W1's shape, decided): a trailing assistant message that pi ran
    // because a BACKGROUND SUBAGENT's result was injected mid-turn is not the
    // model declining to answer the sender.
    //
    // pi's agent loop runs another assistant message whenever a steer or a
    // follow-up arrives, and `pi-subagents-lite` delivers a finished background
    // agent exactly that way — as a `role: "custom"`, `customType:
    // "subagent-result"` message. Since 2026-08-17 the reply to it can be
    // reasoning-only, which has no text and no toolCall, so this read
    // `produced-no-answer` for a turn that had already answered, and the sender
    // was told the model said nothing.
    //
    // Walking past it is safe in a way that walking past a general empty tail is
    // NOT — and the difference is the whole reason this was left alone for three
    // passes. The incident in `finalAssistantText`'s header is a run whose OWN
    // final turn was empty, where walking back crossed the sender's own `user`
    // message and delivered the PREVIOUS turn's deliberation to Matrix. That
    // boundary is still respected: the pair is stepped over only when the empty
    // message is immediately preceded by a `subagent-result`, and a `user`
    // message — the sender's question, or an operator steer that changed the
    // subject — is never crossed. Nothing that could resurrect the incident is.
    if (isBackgroundSubagentResult(value)) continue;
    // Fourteenth pass (AE7): the sender's own question ends the walk, exactly as
    // it ends `finalAssistantText`'s.
    //
    // This used to `continue` past a `user` message like any other non-assistant
    // one, so the walk could leave the run's own tail and find an answer from
    // BEFORE the message being answered — and report `empty: false` for a run
    // that had answered nobody. `finalAssistantText` stops here (that boundary is
    // what the incident in its header bought), so the pair disagreed: this said
    // "there is an answer", that returned "", and the result was a sender whose
    // question was retired with no answer, no continuation and no notice.
    //
    // Reachable through the pair this function already steps over: a run whose
    // tail is `… assistant(answer) · user(the matrix question) · custom
    // subagent-result · assistant(reasoning-only)` skips the last two and lands
    // on the `user` message. The question was not answered, and `empty: true` is
    // the honest reading — it is also the safe direction, because
    // `finalAssistantText` returns "" either way and the only thing that changes
    // is whether the sender gets a continuation instead of silence.
    if (value?.role === 'user') break;
    if (!value || value.role !== 'assistant') continue;

    const content = value.content;
    // "Said nothing" is not the same as "has no blocks", and the difference
    // arrived with the forge patch. Before it, a reasoning-only turn reached pi
    // as `content: []` because forge destroyed the reasoning; now it arrives as
    // `content: [thinking]`. That is strictly better — the thinking is visible,
    // and the Matrix forwarder still refuses to relay it — but it is still not
    // an answer, and a check for an empty array would stop noticing.
    //
    // A tool call IS progress: a run ending on one has its answer above it, and
    // `finalAssistantText` walks back to find it. Only text and tool calls
    // count.
    const isEmpty =
      typeof content === 'string'
        ? content.trim().length === 0
        : Array.isArray(content) &&
          !content.some((part) => {
            const type = (part as { type?: unknown } | null)?.type;
            return type === 'text' || type === 'toolCall';
          });
    if (!isEmpty) return { empty: false };
    sawEmptyTail = true;

    // Empty — but is it the model declining to answer the sender, or the reply
    // to a background subagent's result that pi injected after the answer? Only
    // the message directly above decides, and only a `subagent-result` counts.
    if (isBackgroundSubagentResult(messages[index - 1])) continue;

    // `length` means the backend hit the token cap mid-output. This only became
    // distinguishable once patches/forge_reasoning_passthrough.py stopped forge
    // hardcoding finish_reason to "stop"; before that a truncated turn was
    // indistinguishable from one the model chose to end.
    if (value.stopReason === 'length') {
      const output = typeof value.usage?.output === 'number' ? value.usage.output : 0;
      return {
        empty: true,
        reason: 'truncated',
        detail: `the model was cut off after ${output} tokens, mid-answer`,
      };
    }

    if (value.stopReason === 'error') {
      const detail = typeof value.errorMessage === 'string' && value.errorMessage ? value.errorMessage : 'no detail';
      return { empty: true, reason: 'error', detail: `the request failed: ${detail}` };
    }

    const output = typeof value.usage?.output === 'number' ? value.usage.output : 0;
    if (output > 1) {
      return {
        empty: true,
        reason: 'produced-no-answer',
        detail: `the model generated ${output} tokens but none of them were an answer`,
      };
    }

    if (typeof contextPercent === 'number' && contextPercent >= 87) {
      return {
        empty: true,
        reason: 'context',
        detail: `the context was ${Math.round(contextPercent)}% full`,
      };
    }

    return { empty: true, reason: 'unknown', detail: 'the model returned an empty turn' };
  }
  // Fourteenth pass (AE7). The walk ended at the sender's own `user` message, or
  // ran off the start of the run, having stepped over an empty tail and one or
  // more injected `subagent-result` pairs. The run answered nobody.
  //
  // Before this, the `user` message was `continue`d past like any other
  // non-assistant one, so the walk could leave the run's own tail and find an
  // answer from BEFORE the message being answered — and report `empty: false`
  // for a run that had answered nobody. `finalAssistantText` stops at that
  // boundary (the incident in its header is what bought it), returns "", and the
  // two then disagreed silently: no text was forwarded, no empty ending was
  // reported, no continuation was started, and the room was retired. The sender
  // got nothing and was told nothing.
  //
  // `sawEmptyTail` is what keeps this narrow: a run with no assistant message at
  // all is still `empty: false`, which is what it has always been and what the
  // suite pins.
  return sawEmptyTail
    ? { empty: true, reason: 'unknown', detail: 'the run produced no answer after the message it was given' }
    : { empty: false };
}

/** Back-compatible predicate: did the run end without an answer, whatever the cause. */
export function endedWithoutAnswering(messages: readonly unknown[]): boolean {
  return describeEmptyEnding(messages).empty;
}

/**
 * The closing text of a finished run: the last assistant message that had any.
 *
 * Walking back past a trailing message with no text is deliberate — a run that
 * ends on a tool call still has an answer above it, and that is what the sender
 * asked for.
 *
 * It stops at an EMPTY final turn, though, and that distinction was paid for.
 * A 17,790-character tool result filled the window, the model returned
 * `content: []`, pi settled the run, and this walked back to the previous turn —
 * which was mid-investigation deliberation ("I need to investigate further. Let
 * me check the details. So, adding the browser UA consistently works...") — and
 * delivered it to Matrix as the answer. The sender got a thinking trace.
 *
 * An empty final turn does not mean "the answer is further up". It means the
 * model produced nothing, and there is no answer to send.
 */
export function finalAssistantText(messages: readonly unknown[]): string {
  if (endedWithoutAnswering(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    // Stop where `describeEmptyEnding` stops. Its walk now steps over an
    // injected `subagent-result` and the reasoning-only reply to it, so this one
    // has to reach the same message — otherwise the pair disagree about which
    // run answered, and the disagreement is silent.
    //
    // A `user` message still ends the search: that is the sender's own question,
    // and anything above it belongs to an earlier exchange. The empty-final-turn
    // guard above is what the incident in this header bought, and it is
    // unchanged.
    const value = messages[index] as { role?: unknown } | undefined;
    if (value?.role === 'user') break;
    const text = assistantTextOfMessage(messages[index]);
    if (text) return text;
  }
  return '';
}

/**
 * A background subagent's result, injected into a run that was already going.
 *
 * `pi-subagents-lite`'s `SpawnCoordinator.emitIndividualNudge` sends it with
 * `pi.sendMessage({customType: "subagent-result", …})`, which pi turns into a
 * `role: "custom"` message. It is the one injected message this package needs to
 * step over, and it is identified by that customType rather than by "any custom
 * message" so that nothing else — a loop turn, a context-budget line — is
 * silently treated as invisible.
 */
function isBackgroundSubagentResult(value: unknown): boolean {
  const message = value as { role?: unknown; customType?: unknown } | null | undefined;
  return message?.role === 'custom' && message?.customType === 'subagent-result';
}

/**
 * Is this user message the inbound message pi was handed for that pending room?
 *
 * The question behind it is when a room becomes eligible to receive the
 * assistant's text, and getting it wrong leaks. A Matrix message can arrive
 * while pi is mid-turn on something the operator asked for in the terminal;
 * it is queued, correctly, as a follow-up. If the room counted as "waiting"
 * from the moment it arrived, the answer to the operator's private local work
 * would be forwarded to whoever just messaged — silently, and from this side
 * invisibly.
 *
 * So eligibility waits for evidence: pi emitting that exact text as a user
 * message, which is pi saying it has consumed it.
 *
 * Matched on the whole injected string rather than on an identifier parsed out
 * of it. The old `<channel …>` block published `message_id` as an attribute and
 * this read it back; dropping those attributes to save ~55 tokens a message
 * would have left nothing to parse. Comparing against what was actually sent is
 * also strictly the safer test: an identifier can be *written* by a sender into
 * their own message body, and the previous implementation needed a start-anchor
 * and a no-`m`-flag regex specifically to stop someone marking a room live by
 * typing `message_id="…"` at anyone. There is nothing to forge here — a sender
 * would have to reproduce the harness's own rendering of their own message,
 * which gains them nothing.
 */
export function blockMatches(
  userMessageText: string,
  entry: { roomId: string; messageId?: string | undefined; injected?: string | undefined }
): boolean {
  if (entry.injected) return userMessageText.trim() === entry.injected.trim();
  // No record of what was injected: refuse rather than guess. A false positive
  // here forwards somebody's private terminal work to a stranger, and a false
  // negative only means the answer has to be sent with the tool.
  return false;
}

/**
 * What has already been said to whom, for the length of one run.
 *
 * A model that both writes an answer and calls `prinny(reply)` with the same
 * words is the common case on a small model, not an edge one — the tool
 * description tells it forwarding happens, and it calls the tool anyway. Sending
 * that twice makes the bot look broken, so the text is matched rather than the
 * mechanism: normalised for whitespace and case, because a model rarely
 * reproduces its own wording byte for byte.
 */
export class SentRegistry {
  private readonly byRoom = new Map<string, Set<string>>();

  static normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  mark(room: string, text: string): void {
    const seen = this.byRoom.get(room) ?? new Set<string>();
    seen.add(SentRegistry.normalize(text));
    this.byRoom.set(room, seen);
  }

  has(room: string, text: string): boolean {
    return this.byRoom.get(room)?.has(SentRegistry.normalize(text)) ?? false;
  }

  clear(): void {
    this.byRoom.clear();
  }
}
