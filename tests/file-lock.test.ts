/**
 * The cross-process lock under `access.json` and `.env`.
 *
 * Carried in the backlog since the eleventh pass as "`access.json` and `.env`
 * each have two writers in two processes, both read-modify-write. The repair is
 * a lock file." The first pass on it found the diagnosis was half right and the
 * half it missed is the sharper one:
 *
 *   LOST UPDATE — what the backlog described. Whole-document read-modify-write
 *   from two processes, last writer wins. `withFileLock` is the repair, and the
 *   racer suite below proves it against real child processes with the control
 *   run alongside: unlocked, the same racers MUST lose writes, or the locked
 *   result proves nothing.
 *
 *   SPLICED CONTENT — what it missed. Both writers used the SAME temp path,
 *   `${file}.tmp`, and `writeFileSync` opens O_TRUNC. That is not a lost update,
 *   it is a corrupt one: `readAccessFile` quarantines the result and every
 *   allowlist entry is gone. Fixed separately, by making the temp path unique
 *   per process; asserted here because the two repairs are only correct
 *   together.
 *
 * Both implementations are imported. `server/src/file-lock.ts` is a deliberate
 * copy — the sidecar compiles out of this repo with `rootDir: src` and cannot
 * import from `src/` — the same arrangement `stateDir()` has, and it is only as
 * good as an assertion that the two agree.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';

import { afterEach, beforeEach, describe, expect, it } from './harness.ts';
import { STALE_MS, TIMEOUT_MS, lockPathFor, withFileLock } from '../src/file-lock.ts';
import * as sidecar from '../server/src/file-lock.ts';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RACER = join(PACKAGE_ROOT, 'tests', 'fixtures', 'lock-racer.mjs');

let dir: string;
let target: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prinny-lock-'));
  target = join(dir, 'access.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => JSON.parse(readFileSync(target, 'utf8')) as { count: number; writers: Record<string, number> };

function race(impl: string, mode: 'locked' | 'unlocked', racers = 4, iterations = 4, holdMs = 25): Promise<void> {
  writeFileSync(target, JSON.stringify({ count: 0, writers: {} }));
  const startFile = join(dir, 'go');
  const children = Array.from({ length: racers }, () =>
    spawn(
      process.execPath,
      ['--experimental-strip-types', RACER, impl, target, String(iterations), mode, String(holdMs), startFile],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    )
  );
  // Let every child reach its spin before any of them starts working, so the
  // interleaving is a race rather than a queue.
  setTimeout(() => writeFileSync(startFile, 'go'), 250);
  return Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`racer exited ${code}`))));
          child.on('error', reject);
        })
    )
  ).then(() => undefined);
}

for (const [name, impl] of [
  ['extension', join(PACKAGE_ROOT, 'src', 'file-lock.ts')],
  ['sidecar', join(PACKAGE_ROOT, 'server', 'src', 'file-lock.ts')],
] as const) {
  describe(`${name}: four processes, one file`, () => {
    it('loses nothing when every writer takes the lock', async () => {
      await race(impl, 'locked');
      expect(read().count).toBe(16);
    });

    it('and loses writes when they do not — the control', async () => {
      // If this ever passes, the test above is passing for some reason other
      // than the lock, and neither result means anything.
      await race(impl, 'unlocked');
      const { count } = read();
      assert.ok(count < 16, `unlocked racers should have lost writes, got ${count} of 16`);
    });

    it('leaves no lock behind', async () => {
      await race(impl, 'locked');
      expect(existsSync(lockPathFor(target))).toBe(false);
    });
  });
}

describe('the two implementations agree', () => {
  it('on the bounds and the lock path', () => {
    expect(sidecar.STALE_MS).toBe(STALE_MS);
    expect(sidecar.TIMEOUT_MS).toBe(TIMEOUT_MS);
    expect(sidecar.lockPathFor('/x/y.json')).toBe(lockPathFor('/x/y.json'));
  });

  it('and neither imports the other', () => {
    const mine = readFileSync(join(PACKAGE_ROOT, 'src', 'file-lock.ts'), 'utf8');
    const theirs = readFileSync(join(PACKAGE_ROOT, 'server', 'src', 'file-lock.ts'), 'utf8');
    expect(/from ['"].*server\//.test(mine)).toBe(false);
    expect(/from ['"]\.\.\/\.\.\/src\//.test(theirs)).toBe(false);
  });

  it('and the bound leaves room to break a stale lock before giving up', () => {
    // A timeout at or below STALE_MS could expire while the only thing in the
    // way is a lock that was already breakable.
    assert.ok(TIMEOUT_MS > STALE_MS, `TIMEOUT_MS ${TIMEOUT_MS} must exceed STALE_MS ${STALE_MS}`);
  });
});

describe('the ways it gives up', () => {
  it('breaks a lock older than staleMs and says so', () => {
    writeFileSync(lockPathFor(target), '999999 0\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPathFor(target), old, old);
    const warnings: string[] = [];
    const ran = withFileLock(target, () => 'body ran', { onWarn: (m) => warnings.push(m) });
    expect(ran).toBe('body ran');
    expect(warnings.join('')).toContain('breaking a');
    expect(existsSync(lockPathFor(target))).toBe(false);
  });

  it('runs the body anyway when a live lock outlasts the budget, and reports it', () => {
    writeFileSync(lockPathFor(target), '999999 0\n');
    const warnings: string[] = [];
    // staleMs high enough that the lock is never breakable, timeout short.
    const ran = withFileLock(target, () => 'body ran', {
      staleMs: 600_000,
      timeoutMs: 40,
      onWarn: (m) => warnings.push(m),
    });
    expect(ran).toBe('body ran');
    expect(warnings.join('')).toContain('running without');
    // …and it did NOT delete a lock it never held.
    expect(existsSync(lockPathFor(target))).toBe(true);
  });

  it('runs the body anyway when the lock cannot be created at all', () => {
    const warnings: string[] = [];
    // A lock path inside a directory that does not exist: EEXIST is the only
    // error treated as contention, everything else is a broken lock directory.
    const unreachable = join(dir, 'no-such-dir', 'access.json');
    const ran = withFileLock(unreachable, () => 'body ran', { onWarn: (m) => warnings.push(m) });
    expect(ran).toBe('body ran');
    expect(warnings.join('')).toContain('continuing without the lock');
  });

  it('does not release a lock that was broken and retaken while it held it', () => {
    const warnings: string[] = [];
    withFileLock(
      target,
      () => {
        // Someone declared us dead and took their own.
        writeFileSync(lockPathFor(target), '424242 1\n');
      },
      { onWarn: (m) => warnings.push(m) }
    );
    expect(readFileSync(lockPathFor(target), 'utf8')).toContain('424242');
    expect(warnings.join('')).toContain('broken and retaken');
  });

  it('releases the lock even when the body throws', () => {
    expect(() =>
      withFileLock(target, () => {
        throw new Error('body failed');
      })
    ).toThrow('body failed');
    expect(existsSync(lockPathFor(target))).toBe(false);
  });

  it('stamps the holding pid, so a breaker has something to name', () => {
    let held = '';
    withFileLock(target, () => {
      held = readFileSync(lockPathFor(target), 'utf8');
    });
    expect(held.startsWith(`${process.pid} `)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});

describe('the temp paths the writers use', () => {
  const sources = [
    ['src/access-store.ts', 'access.json, extension side'],
    ['server/src/access.ts', 'access.json, sidecar side'],
    ['server/src/state.ts', '.env, sidecar side'],
    ['extensions/index.ts', '.env, extension side'],
    ['src/json-store.ts', 'pi.json'],
    ['server/src/queue.ts', 'queue.json'],
  ] as const;

  for (const [file, what] of sources) {
    it(`${what} (${file}) writes to a temp path unique to its process`, () => {
      const source = readFileSync(join(PACKAGE_ROOT, file), 'utf8');
      // The shape that caused the splice: a temp path with nothing in it that
      // distinguishes one writer from another.
      const shared = /const tmp = `\$\{[A-Za-z_]+\}\.tmp`/.test(source);
      expect(shared).toBe(false);
      expect(/const tmp = `\$\{[A-Za-z_]+\}\.\$\{process\.pid\}\.tmp`/.test(source)).toBe(true);
    });
  }
});
