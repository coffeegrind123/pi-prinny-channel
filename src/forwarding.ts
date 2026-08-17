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

/** The closing text of a finished run: the last assistant message that had any. */
export function finalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = assistantTextOfMessage(messages[index]);
    if (text) return text;
  }
  return '';
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
