/**
 * AN2 — the runtime three readers called "built".
 *
 * The sidecar runs from a staged, compiled runtime outside the repo, keyed on a
 * content fingerprint of `server/src` plus the three build files.
 * `server/bin/prinny-channel.mjs` decides "prepared" as
 * `existsSync(ENTRY) && stampMatches(sourceFingerprint())`. Three other readers
 * — `startupBlocker()`, `/prinny status`, `/prinny configure` — and
 * `scripts/pi-local.sh`'s launch line asked `existsSync(dist/server.js)` alone,
 * and those four are the ones that talk to the operator.
 *
 * Measured on this box while the finding was written:
 *
 * ```
 *   .source-stamp                     f297f2b6…   staged 2026-08-22 14:43
 *   fingerprint of server/src now     53371dab…
 *   staged src/ vs the checkout       connect.ts MISSING, server.ts differs
 *   `prinny-channel.mjs --staged`     stale (exit 1)
 * ```
 *
 * — so the sidecar in that runtime was the build from before AL3, the
 * twenty-first pass's fix for a connect loop that builds one matrix-js-sdk
 * client per failed attempt and stops none of them, and all four readers said
 * "built".
 *
 * The next start would have re-staged it, which is the part that matters: an
 * `npm install` plus `tsc` inside a 120 s connect budget that already spends a
 * measured 27.5 s importing the Matrix stack. The bootstrap's own header names
 * that failure and says `--prepare` exists to keep the operator out of it.
 *
 * This suite drives the module. The extension's use of it is pinned by source
 * text, because `extensions/index.ts` imports pi-tui and typebox and this suite
 * cannot load it.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { assertRuntimeMatchesSource } from './harness.ts';
import { fileURLToPath } from 'node:url';

import {
  STAGED_FILES,
  entryPath,
  readStamp,
  sourceFingerprint,
  stagedState,
  stampPath,
} from '../server/bin/runtime-stamp.mjs';

const PAYLOAD_ROOT = fileURLToPath(new URL('../server', import.meta.url));
const EXTENSION = readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf8');
const BOOTSTRAP = readFileSync(new URL('../server/bin/prinny-channel.mjs', import.meta.url), 'utf8');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'an2-'));
}

/** A payload tree that looks like `server/`: the build files and a src/. */
function payload(): string {
  const dir = join(scratch(), 'payload');
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
  for (const file of STAGED_FILES) writeFileSync(join(dir, file), `{"name":"${file}"}`);
  writeFileSync(join(dir, 'src', 'server.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'nested', 'deep.ts'), 'export const b = 2;\n');
  return dir;
}

/** A runtime staged from that payload, as `--prepare` leaves one. */
function staged(payloadRoot: string): string {
  const dir = join(scratch(), 'runtime');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(entryPath(dir), '// compiled\n');
  writeFileSync(stampPath(dir), sourceFingerprint(payloadRoot));
  return dir;
}

describe('sourceFingerprint', () => {
  it('is stable for the same bytes', () => {
    const root = payload();
    assert.equal(sourceFingerprint(root), sourceFingerprint(root));
  });

  it('is the same for a copy — mtimes are not in it', () => {
    // The reason it hashes content: a fresh clone, a branch switch and a
    // `git checkout` all rewrite mtimes, and each would otherwise cost a minute
    // of installing and compiling for a byte-identical tree.
    const root = payload();
    const copy = join(scratch(), 'copy');
    cpSync(root, copy, { recursive: true });
    assert.equal(sourceFingerprint(copy), sourceFingerprint(root));
  });

  it('moves when a source file changes', () => {
    const root = payload();
    const before = sourceFingerprint(root);
    writeFileSync(join(root, 'src', 'server.ts'), 'export const a = 2;\n');
    assert.notEqual(sourceFingerprint(root), before);
  });

  it('moves when a source file is ADDED — the AL3 case exactly', () => {
    // The staged tree on this box was missing `connect.ts` entirely: a file the
    // twenty-first pass added and the runtime had never seen.
    const root = payload();
    const before = sourceFingerprint(root);
    writeFileSync(join(root, 'src', 'connect.ts'), 'export const c = 3;\n');
    assert.notEqual(sourceFingerprint(root), before);
  });

  it('moves when a source file is removed', () => {
    const root = payload();
    const before = sourceFingerprint(root);
    rmSync(join(root, 'src', 'nested', 'deep.ts'));
    assert.notEqual(sourceFingerprint(root), before);
  });

  it('moves when a build file changes', () => {
    const root = payload();
    const before = sourceFingerprint(root);
    writeFileSync(join(root, 'tsconfig.build.json'), '{"changed":true}');
    assert.notEqual(sourceFingerprint(root), before);
  });

  it('is about names as well as contents', () => {
    // Path and content both go into the hash, so two files swapping names is a
    // change even though the bytes on disk are the same set.
    const root = payload();
    const before = sourceFingerprint(root);
    writeFileSync(join(root, 'src', 'server.ts'), 'export const b = 2;\n');
    writeFileSync(join(root, 'src', 'nested', 'deep.ts'), 'export const a = 1;\n');
    assert.notEqual(sourceFingerprint(root), before);
  });
});

describe('stagedState', () => {
  it('absent when nothing is compiled', () => {
    assert.equal(stagedState(join(scratch(), 'runtime'), payload()), 'absent');
  });

  it('current when the stamp matches', () => {
    const root = payload();
    assert.equal(stagedState(staged(root), root), 'current');
  });

  it('stale when the source has moved on — the finding', () => {
    const root = payload();
    const runtime = staged(root);
    writeFileSync(join(root, 'src', 'connect.ts'), 'export const c = 3;\n');
    assert.equal(stagedState(runtime, root), 'stale');
  });

  it('stale when there is a build but no stamp at all', () => {
    // A runtime from before stamping, or one whose stamp was removed. There is
    // no evidence it is current, and guessing "current" is the failure.
    const root = payload();
    const runtime = staged(root);
    rmSync(stampPath(runtime));
    assert.equal(readStamp(runtime), undefined);
    assert.equal(stagedState(runtime, root), 'stale');
  });

  it('absent outranks stale: no entry is no entry', () => {
    const root = payload();
    const runtime = staged(root);
    rmSync(entryPath(runtime));
    assert.equal(stagedState(runtime, root), 'absent');
  });

  it('takes a precomputed fingerprint rather than hashing twice', () => {
    const root = payload();
    const runtime = staged(root);
    assert.equal(stagedState(runtime, root, sourceFingerprint(root)), 'current');
    assert.equal(stagedState(runtime, root, 'not-the-fingerprint'), 'stale');
  });
});

describe('AN2 — the readers ask the same question', () => {
  it('the bootstrap uses the module rather than its own copy', () => {
    assert.match(BOOTSTRAP, /from '\.\/runtime-stamp\.mjs'/);
    assert.doesNotMatch(BOOTSTRAP, /function sourceFingerprint\(/, 'one implementation, not two');
    assert.doesNotMatch(BOOTSTRAP, /function stampMatches\(/);
  });

  it('the bootstrap answers --staged without staging anything', () => {
    const at = BOOTSTRAP.indexOf("--staged");
    const bootstrapAt = BOOTSTRAP.indexOf('\nbootstrap()');
    assert.ok(at >= 0, 'the shell needs a way to ask');
    assert.ok(at < BOOTSTRAP.indexOf('if (PREPARE_ONLY)'), 'answered before anything can install');
    assert.ok(bootstrapAt < 0 || at < bootstrapAt);
  });

  it('the extension asks stagedState, not existsSync', () => {
    assert.match(EXTENSION, /import \{ stagedState \} from '\.\.\/server\/bin\/runtime-stamp\.mjs'/);
    assert.doesNotMatch(
      EXTENSION,
      /existsSync\(RUNTIME_ENTRY\)/,
      'the weaker question cannot see a runtime built from other sources',
    );
  });

  it("…in all three places that used to ask the weaker one", () => {
    const blocker = EXTENSION.slice(EXTENSION.indexOf('function startupBlocker'));
    assert.match(blocker.slice(0, 1_400), /runtimeState\(\)/, 'startupBlocker');
    assert.match(blocker.slice(0, 1_400), /'stale'/, '…and it distinguishes the third state');

    const status = EXTENSION.slice(EXTENSION.indexOf('  runtime:      '));
    assert.match(status.slice(0, 400), /STALE/, '/prinny status says so');

    assert.match(EXTENSION, /runtimeState\(\) === 'current' \? '' : /, 'configure prepares a stale runtime');
  });

  it('the launcher asks the bootstrap rather than stat-ing the entry', () => {
    const launcher = readFileSync(new URL('../../../scripts/pi-local.sh', import.meta.url), 'utf8');
    assert.match(launcher, /--staged/, 'one node start, and it is the same answer');
  });
});

describe('AO5 — the fifth reader is the one that runs the tests', () => {
  /**
   * `loadServerModule` imports the sidecar's COMPILED output, and its docstring
   * calls that a benefit: "testing the artifact that actually ships rather than
   * a re-compile of it". That is true while the staged artifact IS this
   * checkout's source, and nothing asked whether it was. AN2 gave four readers
   * the harder question and left out the one whose wrong answer is silent — a
   * stale runtime does not fail a suite, it passes it, about a program that is
   * not in the tree.
   *
   * Measured on this box while the finding was written: stamp `f297f2b6…`,
   * `server/src` hashing to `94b4a2f9…`, no `connect.js` in `dist/` at all, and
   * 511 tests green.
   */
  const harness = readFileSync(new URL('./harness.ts', import.meta.url), 'utf8');

  it('the harness asks stagedState, not existsSync', () => {
    assert.match(harness, /stagedState\(/, 'the harder question');
    assert.match(harness, /assertRuntimeMatchesSource/, 'and it is asked');
    const loader = harness.slice(harness.indexOf('export async function loadServerModule'));
    assert.match(loader.slice(0, 500), /assertRuntimeMatchesSource\(\)/, 'on every module load');
  });

  it('a stale runtime throws, and the sentence names the command that fixes it', () => {
    const runtime = mkdtempSync(join(tmpdir(), 'prinny-stale-'));
    try {
      // A runtime that looks built to the weaker question, stamped for sources
      // that are not these.
      mkdirSync(join(runtime, 'dist'), { recursive: true });
      writeFileSync(join(runtime, 'dist', 'state.js'), 'export const STATE_DIR = "";\n');
      writeFileSync(join(runtime, 'dist', 'server.js'), '\n');
      writeFileSync(join(runtime, '.source-stamp'), 'f'.repeat(64));

      assert.throws(
        () => assertRuntimeMatchesSource(runtime, PAYLOAD_ROOT),
        (err: Error) => {
          assert.match(err.message, /is stale/);
          assert.match(err.message, /different sources than this checkout/);
          assert.match(err.message, /--prepare/);
          assert.match(err.message, /not in the tree/);
          return true;
        },
      );
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  it('an absent runtime throws too, rather than being reported as passing', () => {
    const runtime = mkdtempSync(join(tmpdir(), 'prinny-absent-'));
    try {
      mkdirSync(join(runtime, 'dist'), { recursive: true });
      writeFileSync(join(runtime, 'dist', 'state.js'), '\n');
      // No stamp at all: `stagedState` calls that `absent`.
      assert.throws(() => assertRuntimeMatchesSource(runtime, PAYLOAD_ROOT), /is absent: it has a dist directory but no compiled entry/);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  it('a runtime with no dist at all is left to runtimeAvailable, which has its own advice', () => {
    const runtime = mkdtempSync(join(tmpdir(), 'prinny-none-'));
    try {
      assert.doesNotThrow(() => assertRuntimeMatchesSource(runtime, PAYLOAD_ROOT));
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  it('control — the runtime these tests just ran against is current', () => {
    assert.doesNotThrow(() => assertRuntimeMatchesSource());
  });
});
