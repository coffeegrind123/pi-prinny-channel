/**
 * Reading a permission decision out of a chat message.
 *
 * Claude Code shows a request as a five-letter code and expects "y <code>" or
 * "n <code>" back. The spec is from anthropics/claude-cli-internal
 * (src/services/mcp/channelPermissions.ts): five lowercase letters a–z with
 * 'l' excluded, so it cannot be confused with 1 or I.
 *
 * Deliberately strict. A bare "yes" is conversation, not a decision, and
 * treating it as one would let an ordinary reply approve a tool call the user
 * never looked at. Case-insensitive only because phone keyboards capitalise.
 */

export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

export type PermissionDecision = { requestId: string; behavior: 'allow' | 'deny' };

/** A decision, or null when the message is ordinary conversation. */
export function parsePermissionReply(text: string): PermissionDecision | null {
  const match = PERMISSION_REPLY_RE.exec(text);
  if (!match) return null;
  return {
    requestId: match[2]!.toLowerCase(),
    behavior: match[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
  };
}

/** Callback data for the inline buttons, and the shape that parses it back. */
export const PERMISSION_CALLBACK_RE = /^perm:(allow|deny|more):([a-km-z]{5})$/;

/**
 * The prompts still worth answering, and the whole of AK4's repair.
 *
 * ## What went wrong
 *
 * The extension's `requestApproval` **fails closed on a timeout**: after
 * `permissionTimeoutSeconds` it drops its own pending entry, resolves
 * `timeout`, and the tool call is BLOCKED. It tells the sidecar nothing. The
 * sidecar's map was a plain `Map` with a `set` on arrival and a `delete` on a
 * decision, so a prompt nobody answered stayed in it for the life of the
 * process — one entry per unanswered request, each carrying up to 4,000
 * characters of `input_preview`, which for a `write` call is the file's entire
 * contents.
 *
 * The leak is the small half. The buttons in every paired sender's room stayed
 * live, and pressing Allow on one answered the callback `✅ Allowed` and edited
 * the room's own record to say so — for a command that had already been
 * blocked. The extension logs the late reply as `permission decision for
 * unknown request` and does nothing, correctly; so the only lasting account of
 * what happened was the one in the room, and it said the opposite of the truth.
 *
 * `permission-gate.ts` states what that prompt is for:
 *
 *   > short enough to read on a phone and specific enough to decide on — an
 *   > approval prompt that only names the tool is a prompt that gets approved
 *   > without being read.
 *
 * A prompt that reports a decision nobody acted on is one step further in.
 *
 * ## The shape of the repair
 *
 * `expiresAt` per entry, from the `timeout_ms` the extension now sends, and one
 * function — `live()` — that is the difference between *nobody has answered
 * this yet* and *pi stopped waiting for it forty minutes ago*. A press for an
 * entry `live()` does not return is told so, rather than given an outcome.
 *
 * Here rather than in `server.ts` for the reason `concurrency-slots.ts` gives
 * one package over: `server.ts` ends in a top-level `await mcp.connect(...)`,
 * so importing it starts a sidecar and no test can hold it. This module imports
 * nothing.
 */

/** What the prompt showed, and until when it means anything. */
export interface PermissionPrompt {
  tool_name: string;
  description: string;
  input_preview: string;
}

interface StoredPrompt extends PermissionPrompt {
  expiresAt: number;
}

/**
 * How long a prompt stays answerable when the extension did not say.
 *
 * Matches `DEFAULT_SETTINGS.permissionTimeoutSeconds` in `src/config.ts`. An
 * older extension sends no `timeout_ms`; guessing its default is better than
 * keeping the entry forever, and the only cost of guessing short is a press
 * that is told the request expired when it had a second left — which is the
 * honest direction, because the extension has already stopped waiting by then
 * either way.
 */
export const DEFAULT_PERMISSION_TTL_MS = 300_000;

export class PermissionRegistry {
  private readonly prompts = new Map<string, StoredPrompt>();

  /**
   * Record a prompt. `ttlMs` is the extension's own timeout, so the two sides
   * stop waiting at the same moment rather than at two different ones.
   */
  add(requestId: string, prompt: PermissionPrompt, ttlMs?: number, now = Date.now()): void {
    this.sweep(now);
    const ttl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_PERMISSION_TTL_MS;
    this.prompts.set(requestId, { ...prompt, expiresAt: now + ttl });
  }

  /** The prompt, or undefined once pi has stopped waiting for it. */
  live(requestId: string, now = Date.now()): PermissionPrompt | undefined {
    const entry = this.prompts.get(requestId);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.prompts.delete(requestId);
      return undefined;
    }
    const { expiresAt: _expiresAt, ...prompt } = entry;
    return prompt;
  }

  /** Retire a prompt that has been decided. */
  remove(requestId: string): void {
    this.prompts.delete(requestId);
  }

  /** Drop every prompt nobody can answer any more. */
  sweep(now = Date.now()): void {
    for (const [id, entry] of this.prompts) {
      if (entry.expiresAt <= now) this.prompts.delete(id);
    }
  }

  /** How many prompts are being held. For tests, and for a status line one day. */
  get size(): number {
    return this.prompts.size;
  }
}

/**
 * What a press on a prompt nobody is waiting for any more is told.
 *
 * Says what happened to the CALL, not just to the prompt: "no longer waiting"
 * on its own reads as a UI glitch, and the thing the reader needs to know is
 * that nothing ran.
 */
export const EXPIRED_PERMISSION_MESSAGE =
  '⌛ Permission — no longer waiting. pi stopped waiting for an answer and blocked the call, ' +
  'or somebody else answered it. Nothing was run.';
