/**
 * What the bot is doing, as a Matrix status message.
 *
 * `m.presence`'s `status_msg` is the line clients show under a display name —
 * the "status bubble". Cinny renders it in the member list and the chat list
 * (`PresenceStatus`, preferring it over rich presence in a roster). So a pi
 * session can say what it is actually doing to somebody who is not at the
 * terminal, which is the whole reason the channel exists.
 *
 * ## Measured, on struct.ws:8448, before any of this was written
 *
 * It round-trips — `PUT` then `GET` returns the `status_msg` — and it is rate
 * limited. The limit was probed rather than assumed, by writing at increasing
 * gaps and recording what came back:
 *
 * ```
 *   gap since last write   result
 *   0s (first)             200
 *   2s                     429   retry_after_ms 7200
 *   5s                     429   retry_after_ms 1592
 *   8s                     200
 *   11s                    200
 *   14s                    200
 * ```
 *
 * So a write lands once roughly 8 seconds have passed since the last one that
 * landed — the shape of Synapse's `rc_presence` token bucket. `MIN_INTERVAL_MS`
 * is 12s: above the observed recovery point with headroom, because the cost of
 * being slightly slow is a status line a few seconds stale, and the cost of
 * being slightly fast is a 429 and no update at all.
 *
 * **Presence works and presence is rate-limited.** That is the design. A status that followed the model tool-for-tool would spend its budget
 * in the first three seconds of a turn and then be throttled for the rest of it,
 * so the writer coalesces: callers offer as often as they like, at most one
 * write leaves per interval, and it is always the LATEST value — a stale
 * "reading foo.ts" arriving after the run finished is worse than no status.
 *
 * Rich presence (MSC4320 — an activity with a name, image and details) would be
 * nicer and is not reachable: it is written as an MSC4133 extended profile
 * field, and that homeserver advertises neither. It is Matrix v1.12 and the
 * `unstable_features` list has no MSC4133 entry. See FORK.md AQ4.
 *
 * Nothing here talks to Matrix. `server/src/server.ts` owns the client; this
 * module owns the wording and the timing, so both can be tested with bare node.
 */

export type PresenceState = 'online' | 'unavailable' | 'offline';

export interface StatusTarget {
  presence: PresenceState;
  statusMsg: string;
}

/**
 * Matrix status lines are rendered inline next to a display name, so a long one
 * is truncated by the client rather than wrapped. Kept well under any client's
 * limit and truncated on a word where possible.
 */
export const MAX_STATUS_CHARS = 60;

/**
 * Floor between presence writes. See the measured table in this file's header:
 * 2s and 5s gaps were refused with 429, 8s and above landed.
 */
export const MIN_INTERVAL_MS = 12_000;

export function truncate(text: string, max = MAX_STATUS_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** The tail of a path, enough to recognise it without the tree above it. */
export function shortPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.trim().split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.slice(-2).join('/');
}

function firstString(args: unknown, keys: string[]): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * One line describing a tool call, or null to leave the status alone.
 *
 * Null rather than a generic line for anything unrecognised: "working" replacing
 * a specific "running the tests" is a downgrade, and the throttle would spend a
 * write on it. The named tools are pi's built-ins plus the two families this
 * stack adds.
 */
export function describeActivity(toolName: string, args: unknown): string | null {
  const name = (toolName || '').toLowerCase();

  if (name === 'bash' || name === 'powershell') {
    const command = firstString(args, ['command']);
    if (!command) return null;
    const head = command.trim().split('\n')[0]!.trim();
    return truncate(`$ ${head}`);
  }
  if (name === 'read') {
    const path = shortPath(firstString(args, ['filePath', 'file_path', 'path']));
    return path ? truncate(`reading ${path}`) : 'reading a file';
  }
  if (name === 'write') {
    const path = shortPath(firstString(args, ['filePath', 'file_path', 'path']));
    return path ? truncate(`writing ${path}`) : 'writing a file';
  }
  if (name === 'edit') {
    const path = shortPath(firstString(args, ['filePath', 'file_path', 'path']));
    return path ? truncate(`editing ${path}`) : 'editing a file';
  }
  if (name === 'grep' || name === 'find' || name === 'ls' || name === 'glob') {
    const needle = firstString(args, ['pattern', 'query', 'path']);
    return truncate(needle ? `searching for ${needle}` : 'searching the tree');
  }
  if (name.startsWith('browser_') || name.startsWith('mcp__browser__')) {
    const url = firstString(args, ['url']);
    if (url) {
      // The host is the recognisable part and the rest is usually noise.
      const host = /^https?:\/\/([^/]+)/i.exec(url)?.[1];
      return truncate(host ? `browsing ${host}` : 'browsing');
    }
    return 'browsing';
  }
  if (name === 'agent' || name === 'task') {
    return truncate(firstString(args, ['description']) ?? 'running a subagent');
  }
  return null;
}

/** Status for the phases the turn lifecycle knows about without a tool. */
export const THINKING = 'thinking…';
export const IDLE = '';

/**
 * A latest-wins, rate-limit-aware writer.
 *
 * Callers `offer()` freely. `due()` answers what should go out now, or null.
 * The caller reports back with `wrote()` or `rateLimited()`; nothing here does
 * any I/O, so the whole policy is testable without a homeserver.
 *
 * `minIntervalMs` defaults to `MIN_INTERVAL_MS` (12s), which is measured rather
 * than chosen — see the table in this file's header: 2s and 5s gaps were
 * refused, 8s and above landed. A server-supplied `retry_after_ms` always wins
 * over it, because the server knows its own bucket and this number is only a
 * floor that keeps us away from it.
 */
export class StatusThrottle {
  private pending: StatusTarget | null = null;
  private written: StatusTarget | null = null;
  private nextAllowedAt = 0;
  private readonly minIntervalMs: number;

  // Not a parameter property: node's strip-only TypeScript cannot transform
  // those, and every test here runs under --experimental-strip-types.
  constructor(minIntervalMs = MIN_INTERVAL_MS) {
    this.minIntervalMs = minIntervalMs;
  }

  /** Latest wins. Offering the value already on the server is a no-op. */
  offer(target: StatusTarget): void {
    if (
      this.written &&
      this.written.statusMsg === target.statusMsg &&
      this.written.presence === target.presence
    ) {
      this.pending = null;
      return;
    }
    this.pending = target;
  }

  /** What to write now, or null. Does not mutate — call `wrote()` after. */
  due(now: number): StatusTarget | null {
    if (!this.pending) return null;
    if (now < this.nextAllowedAt) return null;
    return this.pending;
  }

  /** When the next write could happen, for a caller scheduling a timer. */
  waitMs(now: number): number {
    if (!this.pending) return Infinity;
    return Math.max(0, this.nextAllowedAt - now);
  }

  wrote(now: number, target: StatusTarget): void {
    this.written = target;
    this.nextAllowedAt = now + this.minIntervalMs;
    // Only clear if nothing newer arrived while the write was in flight.
    if (
      this.pending &&
      this.pending.statusMsg === target.statusMsg &&
      this.pending.presence === target.presence
    ) {
      this.pending = null;
    }
  }

  /**
   * The server refused. Keep `pending` — the point of a latest-wins queue is
   * that a refused write is retried with whatever is current by then, not with
   * the value that was refused.
   */
  rateLimited(now: number, retryAfterMs?: number): void {
    const wait = typeof retryAfterMs === 'number' && retryAfterMs > 0 ? retryAfterMs : this.minIntervalMs;
    this.nextAllowedAt = now + wait;
  }

  /** For tests and for `/prinny` to report what the server was last told. */
  lastWritten(): StatusTarget | null {
    return this.written;
  }
}
