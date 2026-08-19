/**
 * compaction-lock.ts — Forge fork. Is somebody already compacting this session?
 *
 * ## The collision
 *
 * Two extensions in this stack call `ExtensionContext.compact()`, and both of
 * them can do it from the same `agent_settled`:
 *
 *   pi-loop-mode     runs FIRST, and may request an emergency compaction when
 *                    `contextRecoveryPending` is set
 *   prinny-channel   runs SECOND, and may drain a `/compact` a Matrix sender
 *                    asked for while the session was mid-turn (AD3)
 *
 * pi's `compact()` does not refuse a second call. Its first statement is
 * `await this.abort()` (`dist/core/agent-session.js:1367`), and it overwrites
 * `_compactionAbortController` on the way past — so the second call aborts the
 * first one's session work, and `AgentSession.prompt()` throws
 * "Cannot submit a prompt while a compaction is in progress" for anything that
 * arrives in between, into a rejection pi swallows (`emitError`, whose listener
 * set is empty headless).
 *
 * That is §11.7 of `…-claims.md` and §11.12 of `…-omissions.md`: recorded by two
 * passes, closed by neither, because the honest fix is a flag **neither package
 * owns**.
 *
 * ## Why a global rather than a shared module
 *
 * The same reason `shell.ts` publishes `__PI_SUBAGENT_SPAWN_DEPTH__` on
 * `globalThis`: vendor packages must not depend on each other. `pi-loop-mode` is
 * a fork of an upstream package that knows nothing about Matrix, and
 * `prinny-channel` is a conversion of a Claude Code plugin that knows nothing
 * about loops. One global read is a smaller wound than a cross-vendor import,
 * and node's module cache means both extensions really are in one process — that
 * is the whole reason the collision exists in the first place.
 *
 * So the PROTOCOL is the contract, and this file is one implementation of it.
 * `vendor/pi-loop-mode/src/compaction-lock.ts` is the other, and the two are
 * asserted to agree by a test in each package that reads the other's source —
 * the same arrangement `stateDir()` has in `prinny-channel/src/config.ts` and
 * `server/src/state.ts`.
 *
 * ## The protocol
 *
 *   globalThis[KEY] = { owner: string, at: number } | undefined
 *
 *   beginCompaction(owner)   false when somebody else holds it; otherwise takes
 *                            it and returns true
 *   endCompaction(owner)     releases it, and ONLY if this owner holds it
 *   compactionInFlight()     the holder, or undefined
 *
 * ## Why the entry carries a timestamp
 *
 * `ctx.compact()` is fire-and-forget, and pi's wrapper does guarantee a callback
 * — checked rather than assumed (`dist/core/agent-session.js:1911`):
 *
 * ```js
 *   compact: (options) => { void (async () => {
 *       try { const result = await this.compact(options?.customInstructions);
 *             options?.onComplete?.(result); }
 *       catch (error) { options?.onError?.(err); }
 *   })(); },
 * ```
 *
 * So exactly one of the two fires on every path, and the release is the first
 * statement in each. The timestamp is therefore a BACKSTOP, not the expected
 * path: what it covers is the process outliving the session (this lock is
 * process-global, like every other piece of state these extensions keep), a
 * future pi that changes that wrapper, and a caller that forgets to release.
 * A plain boolean would latch for the rest of the process in each of those, and a
 * latched lock is worse than the collision it prevents — the loop would stand
 * aside for a compaction that is not happening, forever.
 *
 * `STALE_MS` is five minutes, chosen the way `DEFAULT_VERIFY_TIMEOUT_MS` was:
 * long enough that a real compaction is never treated as absent (pi's summariser
 * is a model call on a 27B; the loop's own handoff builds locally in
 * milliseconds), short enough that a lost release costs one wait rather than the
 * session.
 */

/** The one key both implementations agree on. Changing it is a protocol change. */
export const COMPACTION_LOCK_KEY = "__PI_COMPACTION_IN_FLIGHT__";

/**
 * How long a holder may go unreleased before it is treated as absent.
 *
 * Five minutes. See the header: a lost callback must cost one wait, not the
 * session.
 */
export const STALE_MS = 300_000;

export interface CompactionHolder {
  owner: string;
  at: number;
}

/** This package's name in the lock, so `endCompaction` cannot release somebody else's. */
export const PRINNY_OWNER = "prinny-channel";

function slot(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function read(now: number): CompactionHolder | undefined {
  const value = slot()[COMPACTION_LOCK_KEY] as CompactionHolder | undefined;
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.owner !== "string" || typeof value.at !== "number") return undefined;
  // A holder past the bound is not a holder. Read as absent rather than cleared:
  // clearing here would race the owner's own `endCompaction`, and the owner check
  // in `endCompaction` already makes a late release harmless.
  if (now - value.at >= STALE_MS) return undefined;
  return value;
}

/** Who is compacting right now, or undefined. `now` is injectable for tests. */
export function compactionInFlight(now: number = Date.now()): CompactionHolder | undefined {
  return read(now);
}

/**
 * Take the lock, or report that somebody else has it.
 *
 * Re-entrant for the SAME owner: a package that asks twice is describing one
 * compaction, and refusing its own second call would turn a harmless double
 * request into a stall. The two callers in `pi-loop-mode` — the context ladder
 * and the stuck ladder — cannot both be in flight, but they are 450 lines apart
 * and the next reader should not have to prove that.
 */
export function beginCompaction(owner: string, now: number = Date.now()): boolean {
  const held = read(now);
  if (held && held.owner !== owner) return false;
  slot()[COMPACTION_LOCK_KEY] = { owner, at: now };
  return true;
}

/** Release the lock, if this owner holds it. Safe to call on every path. */
export function endCompaction(owner: string, now: number = Date.now()): void {
  const held = read(now);
  if (held && held.owner !== owner) return;
  slot()[COMPACTION_LOCK_KEY] = undefined;
}

/** Drop the lock whatever state it is in. For tests, and for a session teardown. */
export function resetCompactionLock(): void {
  slot()[COMPACTION_LOCK_KEY] = undefined;
}
