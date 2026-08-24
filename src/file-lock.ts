/**
 * A cross-PROCESS lock for one file's read-modify-write.
 *
 * WHY THIS EXISTS. `access.json` and `.env` each have two writers in two
 * processes — the pi extension (the `/prinny:access` skill, `updateEnv`) and the
 * sidecar (`gate()` minting and pruning pairings, `writeEnv` saving the device
 * id). Both do read → mutate → write on the WHOLE document, and neither knew
 * about the other. Two failures, not one, and the second is the one with teeth:
 *
 *   LOST UPDATE. Sidecar reads, skill reads, skill approves a pairing and
 *   writes, sidecar increments a reply counter on its older snapshot and writes.
 *   The approval is gone. Run it the other way and a REVOCATION is gone, which
 *   is the same mechanism pointing at an allowlist between a public Matrix ID
 *   and a shell.
 *
 *   SPLICED CONTENT. Both writers used the same temp path — `${file}.tmp` — and
 *   `writeFileSync` opens it O_TRUNC. Two concurrent writers therefore share one
 *   file description-less fd pair on one path: one truncates while the other is
 *   mid-write, the second's remaining bytes land at ITS offset over a file that
 *   just got shorter, and the result is one document's prefix, a hole of NULs,
 *   and another's tail. The rename that follows is atomic and renames THAT. For
 *   `access.json` the reader's own quarantine path then fires and the allowlist
 *   resets to defaults; for `.env` it is the Matrix device id, whose loss makes
 *   the bot a new device that peers will not share room keys with. The temp
 *   paths are now unique per process, which closes that half on its own — this
 *   file closes the other half.
 *
 * DUPLICATED IN `server/src/file-lock.ts`, DELIBERATELY. The sidecar is compiled
 * out of this repo with `rootDir: src`, so it cannot import from here — the same
 * arrangement `stateDir()` already has between `src/config.ts` and
 * `server/src/state.ts`, and `compactionLock` between this package and
 * `pi-loop-mode`. An arrangement like that is only as good as the assertion that
 * the two agree, so `tests/file-lock.test.ts` imports both and runs every case
 * against each.
 *
 * IT DEGRADES RATHER THAN REFUSES. If the lock cannot be taken inside the
 * budget, `withFileLock` runs the body ANYWAY and says so through `onWarn`.
 * That is deliberate: the unlocked path is exactly what shipped before this
 * file, so it cannot be worse — and `gate()` is on the Matrix inbound path,
 * where throwing would turn a race into a dropped message. A race that is
 * reported beats an outage that is not.
 */

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

/**
 * A lock older than this is assumed to belong to a process that died holding
 * it, and is broken. Every critical section here is a read, a mutation of a few
 * kilobytes of JSON and a rename — microseconds. Ten seconds is four orders of
 * magnitude of headroom, so breaking one is nearly always the right call.
 */
export const STALE_MS = 10_000;

/**
 * Longer than STALE_MS on purpose. A stale lock becomes breakable at STALE_MS,
 * so a budget above it means the only way to time out is genuine contention
 * from a live holder — which cannot last, because holders do not block.
 */
export const TIMEOUT_MS = 15_000;

/** Retry interval. Short, because a holder is expected to be gone in microseconds. */
const SPIN_MS = 5;

export type LockOptions = {
  staleMs?: number;
  timeoutMs?: number;
  onWarn?: (message: string) => void;
  /** Injectable for tests; the default is what actually runs. */
  now?: () => number;
};

export function lockPathFor(target: string): string {
  return `${target}.lock`;
}

/**
 * Sleep without a timer and without going async.
 *
 * The callers — `gate()`, `updateAccess()`, `updateEnv()` — are synchronous, and
 * making them async would change every call site in both halves of the package.
 * `Atomics.wait` on a throwaway SharedArrayBuffer is the only way to block a
 * Node main thread for a bounded time without a dependency. It is allowed on
 * the main thread from Node 16 on.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** What we stamp into the lock so a breaker can tell whose it is. */
function stamp(now: number): string {
  return `${process.pid} ${now}\n`;
}

/**
 * Take `target`'s lock, run `fn`, release it.
 *
 * The release only unlinks a lock whose contents are still OURS. Without that
 * check, this sequence loses the mutex entirely: A holds a lock, A stalls past
 * staleMs, B breaks it and takes its own, A finishes and unlinks — B's lock —
 * and C walks straight in while B is still inside its critical section.
 */
export function withFileLock<T>(target: string, fn: () => T, options: LockOptions = {}): T {
  const staleMs = options.staleMs ?? STALE_MS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const warn = options.onWarn ?? (() => undefined);
  const path = lockPathFor(target);

  const started = now();
  let mine: string | undefined;

  while (mine === undefined) {
    const token = stamp(now());
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      mine = token;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // A lock directory we cannot write to is not a reason to refuse the
        // write itself — the same judgement `quarantine()` already makes.
        warn(`could not create ${path} (${err}); continuing without the lock`);
        return fn();
      }
    }

    let age: number;
    try {
      age = now() - statSync(path).mtimeMs;
    } catch {
      continue; // It vanished between the open and the stat: try again at once.
    }

    if (age > staleMs) {
      warn(`breaking a ${Math.round(age)}ms-old lock at ${path}; its holder is presumed dead`);
      try {
        unlinkSync(path);
      } catch {
        // Someone else broke it first. Either way the next attempt decides.
      }
      continue;
    }

    if (now() - started >= timeoutMs) {
      warn(
        `waited ${timeoutMs}ms for ${path} and it is still held; running without ` +
          'the lock. A concurrent write to this file can now be lost.'
      );
      return fn();
    }
    sleepSync(SPIN_MS);
  }

  try {
    return fn();
  } finally {
    let held: string | undefined;
    try {
      held = readFileSync(path, 'utf8');
    } catch {
      held = undefined;
    }
    if (held === mine) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone. Nothing to do and nothing to say.
      }
    } else if (held !== undefined) {
      warn(`not releasing ${path}: it was broken and retaken while we held it`);
    }
  }
}
