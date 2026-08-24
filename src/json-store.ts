/**
 * json-store.ts — Forge fork, twenty-third pass (AN1). What a settings file that
 * cannot be parsed means, and what may be done to it afterwards.
 *
 * ## The second copy, and why there is one
 *
 * `vendor/pi-subagents-lite/src/config/json-store.ts` is the same three
 * functions for the same reason. Vendor packages in this tree do not import each
 * other — that is invariant 5 in
 * `context/design/subagents-loop-verifier-concurrency.md` §10.1, and the
 * compaction lock has four copies under the same rule — so the protocol is
 * written out on both sides and `tests/json-store.test.ts` asserts they agree,
 * exactly as `compaction-lock.test.ts` does for the lock.
 *
 * ## The failure, here
 *
 * `readSettings` opens with a promise its own catch cannot keep:
 *
 * > Anything malformed falls back to the default for that key alone; a typo in
 * > one setting must not silently reset the rest, **because the rest includes
 * > the permission mode**.
 *
 * That is true for a bad VALUE — `asEnum` and `asPositiveInt` are per key. It is
 * false for a bad FILE, which is the likelier typo in hand-edited JSON: a
 * missing comma, a trailing one. `JSON.parse` throws, the catch leaves `raw` as
 * `{}`, and *every* key falls to its default — including `permissionMode`, which
 * goes from `all` to `off`, silently turning off the Matrix approval relay for
 * every tool call in the session.
 *
 * And then the next `/prinny set` writes that defaults object over the file:
 * `settings = { ...settings, [key]: value }; writeSettings(settings)`. The
 * operator's `permissionTools`, timeouts and forward mode are gone, and the
 * only copy of them went with the write.
 *
 * ## The rule
 *
 * A file that could not be parsed is never silently replaced. It is renamed to
 * `<file>.corrupt-<timestamp>` before the first write that would have replaced
 * it, and the operator is told — at the top of `/prinny status`, and on the
 * console for a headless run.
 *
 * `server/src/access.ts` already does this for `access.json`, with the reasoning
 * that applies here word for word:
 *
 * > Quarantine rather than delete: it may be a hand-edit the user wants back,
 * > and starting from defaults beats refusing to run.
 *
 * ## Never throws
 *
 * A settings file is not worth a session. Every path returns a value.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** What a read found. `absent` and `malformed` are the two a bare catch merges. */
export type LayerStatus = 'absent' | 'loaded' | 'malformed';

export interface LayerRead {
  status: LayerStatus;
  /** Present only for `loaded`. */
  value?: Record<string, unknown>;
  /** Present only for `malformed`: the parser's own words, for the operator. */
  error?: string;
}

/** True for a JSON object — not an array, not null, not a scalar. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one JSON object from disk, distinguishing absent from malformed.
 *
 * An empty file reads as absent: a truncated write leaves nothing to keep, and
 * quarantining zero bytes only makes a second file for the operator to delete.
 */
export function readJsonObject(file: string): LayerRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'absent' };
    return { status: 'malformed', error: `${err}` };
  }
  if (text.trim() === '') return { status: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: 'malformed', error: err instanceof Error ? err.message : `${err}` };
  }
  if (!isPlainObject(parsed)) return { status: 'malformed', error: 'not a JSON object' };
  return { status: 'loaded', value: parsed };
}

/** The name a quarantined file takes. Exported so a test and a notice agree on it. */
export function quarantineName(file: string, now: number): string {
  return `${file}.corrupt-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Move a file the reader could not parse out of the way.
 *
 * Returns the new path, or undefined when there was nothing to move or the move
 * failed — in which case the caller writes anyway. Losing an unreadable file is
 * bad; refusing to save the operator's settings because a rename failed is
 * worse, and the notice says which happened.
 */
export function quarantine(file: string, now: number = Date.now()): string | undefined {
  const target = quarantineName(file, now);
  try {
    renameSync(file, target);
    return target;
  } catch {
    return undefined;
  }
}

/**
 * Write JSON atomically: a tmp file beside it, then a rename.
 *
 * Rename rather than truncate-and-write, for the reason `writeSettings` already
 * gave: a crash mid-write would otherwise leave a half-file that reads as "all
 * defaults", quietly turning a configured permission gate back off.
 */
export function writeJsonAtomic(
  file: string,
  value: unknown,
  mode = 0o600
): { ok: true } | { ok: false; error: string } {
  // Unique per process. This helper has one writer today, but the same string
  // in `access.json`'s two writers produced a spliced document and a reset
  // allowlist — and the failure is invisible until a second writer appears.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${err}` };
  }
}
