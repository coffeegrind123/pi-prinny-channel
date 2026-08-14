/**
 * A vitest-shaped surface on top of `node:test`.
 *
 * The suites in this directory came from the Claude Code plugin, where they ran
 * under vitest. vitest is a dependency, and a dependency here would mean a
 * `node_modules` tree under `vendor/` — the one thing this vendoring is
 * arranged to avoid, and the reason the sidecar stages its own runtime outside
 * the repo.
 *
 * So the tests keep their bodies and get their matchers from here. Rewriting
 * 900 lines of assertions by hand would have been the other option, and a
 * mechanical rewrite of that size is exactly where a `toBe` quietly becomes a
 * `toEqual` and a test stops checking what it says it checks.
 *
 * Only the matchers the suites actually use are implemented. An unimplemented
 * one is better as a missing method than as a stub that always passes.
 */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export { after, afterEach, before, beforeEach, describe, it } from 'node:test';

/** Deep partial match: every key in `expected` must match, extras are allowed. */
function matchesObject(actual: unknown, expected: unknown, path = ''): string | null {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(actual, expected)
      ? null
      : `${path || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  if (actual === null || typeof actual !== 'object') {
    return `${path || 'value'}: expected an object, got ${JSON.stringify(actual)}`;
  }
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    const failure = matchesObject(
      (actual as Record<string, unknown>)[key],
      value,
      path ? `${path}.${key}` : key
    );
    if (failure) return failure;
  }
  return null;
}

/** `a.b.c` → the value at that path, and whether the path existed at all. */
function resolvePath(target: unknown, path: string): { found: boolean; value: unknown } {
  let current: unknown = target;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function contains(actual: unknown, needle: unknown): boolean {
  if (typeof actual === 'string') return actual.includes(String(needle));
  if (Array.isArray(actual)) return actual.some((entry) => Object.is(entry, needle));
  if (actual instanceof Set) return actual.has(needle);
  throw new TypeError(`toContain: unsupported subject ${Object.prototype.toString.call(actual)}`);
}

type Matchers = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toThrow(expected?: string | RegExp): void;
  toContain(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toHaveLength(expected: number): void;
  toMatchObject(expected: unknown): void;
  toHaveProperty(path: string, value?: unknown): void;
};

function build(actual: unknown, negated: boolean): Matchers {
  const check = (passed: boolean, message: string) => {
    if (passed === negated) {
      assert.fail(negated ? `expected NOT: ${message}` : message);
    }
  };

  return {
    toBe(expected) {
      check(
        Object.is(actual, expected),
        `expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`
      );
    },
    toEqual(expected) {
      let equal = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        equal = false;
      }
      check(equal, `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
    },
    toThrow(expected) {
      if (typeof actual !== 'function') {
        assert.fail('toThrow expects a function');
      }
      let thrown: unknown;
      let threw = false;
      try {
        (actual as () => unknown)();
      } catch (err) {
        threw = true;
        thrown = err;
      }
      if (!threw) {
        check(false, 'expected the call to throw');
        return;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      if (expected === undefined) {
        check(true, 'expected the call to throw');
        return;
      }
      const matched =
        expected instanceof RegExp ? expected.test(message) : message.includes(expected);
      check(matched, `expected the thrown message ${JSON.stringify(message)} to match ${expected}`);
    },
    toContain(expected) {
      check(
        contains(actual, expected),
        `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`
      );
    },
    toBeNull() {
      check(actual === null, `expected ${JSON.stringify(actual)} to be null`);
    },
    toBeUndefined() {
      check(actual === undefined, `expected ${JSON.stringify(actual)} to be undefined`);
    },
    toHaveLength(expected) {
      const length = (actual as { length?: number } | null)?.length;
      check(length === expected, `expected length ${expected}, got ${length}`);
    },
    toMatchObject(expected) {
      const failure = matchesObject(actual, expected);
      check(failure === null, failure ?? 'expected the object to match');
    },
    toHaveProperty(path, value) {
      const { found, value: resolved } = resolvePath(actual, path);
      if (arguments.length < 2) {
        check(found, `expected property "${path}" to exist`);
        return;
      }
      check(
        found && Object.is(resolved, value),
        `expected property "${path}" to be ${JSON.stringify(value)}, got ${JSON.stringify(resolved)}`
      );
    },
  };
}

export function expect(actual: unknown): Matchers & { not: Matchers } {
  return Object.assign(build(actual, false), { not: build(actual, true) });
}

/**
 * `vi.resetModules()`, as far as these tests need it.
 *
 * The suites use it to re-import a module after changing `PRINNY_STATE_DIR`,
 * because the module captures that path at load. ESM has no module-registry
 * reset, so `loadServerModule` imports from a fresh copy of the directory
 * instead; this only has to bump the counter that selects the copy.
 */
let generation = 0;
export const vi = {
  resetModules(): void {
    generation += 1;
  },
};

/**
 * Where the sidecar's compiled modules live. Must match
 * `server/bin/prinny-channel.mjs`.
 */
function runtimeDist(): string {
  const stateDir =
    process.env.PRINNY_STATE_DIR ??
    join(
      process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? '', '.pi', 'agent'),
      'channels',
      'prinny'
    );
  return join(process.env.PRINNY_RUNTIME_DIR ?? join(stateDir, 'runtime'), 'dist');
}

/**
 * The runtime `dist` to test against, resolved once from the *real* state
 * directory.
 *
 * Resolved at load, deliberately: the suites reassign `PRINNY_STATE_DIR` to a
 * temp directory for isolation, and following that would send this looking for
 * compiled output in a directory that has none.
 */
const DIST = runtimeDist();

/**
 * Import one of the sidecar's modules.
 *
 * The sources cannot be imported directly: they use NodeNext `.js` specifiers
 * that resolve to nothing until compiled, and Node's type stripping does not
 * rewrite a specifier's extension (checked, not assumed — `node main.ts`
 * importing `./dep.js` fails with ERR_MODULE_NOT_FOUND). So the tests run
 * against the compiled output, which has the side benefit of testing the
 * artifact that actually ships rather than a re-compile of it.
 */
export async function loadServerModule<T = Record<string, unknown>>(name: string): Promise<T> {
  const file = join(DIST, `${name}.js`);
  if (!existsSync(file)) {
    throw new Error(
      `${file} does not exist — the channel runtime has not been built.\n` +
        'Build it once with:\n' +
        '  node vendor/prinny-channel/server/bin/prinny-channel.mjs --prepare\n' +
        'It installs the Matrix layer and compiles the payload; it takes about a minute.'
    );
  }
  return (await import(pathToFileURL(join(generationDist(), `${name}.js`)).href)) as T;
}

/**
 * A private copy of `dist` per generation, because a query string only busts
 * the module it is on.
 *
 * These modules capture `PRINNY_STATE_DIR` at load, and the suites change it
 * between cases — so a reload has to be a genuine reload of the whole graph.
 * Importing `access.js?g=2` re-runs `access.js`, but its own `import
 * './state.js'` resolves to the same unadorned URL it did the first time, and
 * `state.js` is where the paths actually live. The result is a module that
 * looks freshly loaded and is still pointed at the first test's directory:
 * every later test then reads the first one's `access.json`.
 *
 * Copying the directory gives every module in it a new URL at once. It is nine
 * small files, so this costs less than the hour spent working out why the
 * fourth test in a file could see the second one's pending pairings.
 */
const copies = new Map<number, string>();

function generationDist(): string {
  const existing = copies.get(generation);
  if (existing) return existing;
  const dir = mkdtempSync(join(tmpdir(), `prinny-dist-${generation}-`));
  cpSync(DIST, dir, { recursive: true });
  copies.set(generation, dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of copies.values()) rmSync(dir, { recursive: true, force: true });
});

/** True when the runtime has been built. Suites use it to fail with advice, not a stack. */
export function runtimeAvailable(): boolean {
  return existsSync(join(DIST, 'state.js'));
}

export const RUNTIME_DIST = DIST;
