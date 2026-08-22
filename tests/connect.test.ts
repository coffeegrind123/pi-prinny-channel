/**
 * AL3 — the client every failed attempt built, and nothing ever stopped.
 *
 * `startMatrix` retries the homeserver forever, deliberately, and constructed a
 * fresh `Bot` on every attempt:
 *
 * ```
 *   attempt 1   buildBot()  →  start() throws  →  sleep 1s
 *   attempt 2   buildBot()  →  start() throws  →  sleep 2s      ← two clients
 *   attempt 3   buildBot()  →  start() throws  →  sleep 3s      ← three
 *   …                                              cap 30s
 * ```
 *
 * Nothing in the loop, and nothing outside it, called `stop()` on any of them.
 * `bot` — the one handle `shutdown()` tears down — is only ever assigned on the
 * SUCCESS path, so every failed attempt's client was unreachable and alive.
 *
 * It is not just memory. `buildBot` passes each one `storePath:
 * CRYPTO_STORE_PATH`, and the header of `server/src/state.ts` — the file that
 * defines that constant — says:
 *
 *   > including the crypto store, **which must never be shared between two
 *   > running bots**.
 *
 * An overnight outage is of the order of a thousand attempts against a 30 s
 * cap, each with its own handlers, its own timers and its own claim on that one
 * store.
 *
 * The control is one package away: the extension's `startChannel` wraps the
 * same shape and its catch says `await instance.stop().catch(() => undefined)`.
 * The difference is that `startChannel` runs once and this loop runs forever.
 *
 * The rule now lives in `server/src/connect.ts`, which imports nothing, so it
 * can be driven here without a homeserver — a hundred failed attempts in a
 * millisecond, against a fake client that records whether it was stopped.
 *
 * See AL3 in `context/design/subagents-loop-verifier-lifetimes.md`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectWithRetry, type ConnectHooks } from '../server/src/connect.ts';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface FakeClient {
  id: number;
  stopped: boolean;
}

interface Trace {
  built: FakeClient[];
  discarded: FakeClient[];
  events: string[];
  slept: number[];
  errors: number[];
}

/**
 * A loop whose attempts fail until `succeedOn`, with every hook recorded.
 *
 * `events` is the ordering channel: the one property that matters beyond "was
 * it stopped" is that it was stopped BEFORE the next one was built, because two
 * live clients is the state `state.ts` forbids.
 */
function drive(
  options: {
    succeedOn?: number;
    failBuildOn?: number[];
    stopAfter?: number;
    discardThrows?: boolean;
  } = {}
): { trace: Trace; result: Promise<FakeClient | undefined> } {
  const { succeedOn = 1, failBuildOn = [], stopAfter } = options;
  const trace: Trace = { built: [], discarded: [], events: [], slept: [], errors: [] };
  let nextId = 1;
  let attempts = 0;

  const hooks: ConnectHooks<FakeClient> = {
    build: (attempt) => {
      attempts = attempt;
      if (failBuildOn.includes(attempt)) {
        trace.events.push(`build-throw:${attempt}`);
        throw new Error(`whoami failed on attempt ${attempt}`);
      }
      const client: FakeClient = { id: nextId++, stopped: false };
      trace.built.push(client);
      trace.events.push(`build:${client.id}`);
      return client;
    },
    start: async (client, attempt) => {
      trace.events.push(`start:${client.id}`);
      if (attempt < succeedOn) throw new Error(`login refused on attempt ${attempt}`);
    },
    discard: async (client, attempt) => {
      if (options.discardThrows) {
        trace.events.push(`discard-throw:${client.id}`);
        throw new Error(`stop() blew up for ${client.id}`);
      }
      client.stopped = true;
      trace.discarded.push(client);
      trace.events.push(`discard:${client.id}@${attempt}`);
    },
    delayMs: (attempt) => attempt * 1000,
    sleep: async (ms) => {
      trace.slept.push(ms);
      trace.events.push(`sleep:${ms}`);
    },
    onError: (attempt) => {
      trace.errors.push(attempt);
    },
    stopping: () => stopAfter !== undefined && attempts >= stopAfter,
  };

  return { trace, result: connectWithRetry(hooks) };
}

describe('AL3 — every client the retry loop builds is either published or stopped', () => {
  it('stops the client of a failed attempt', async () => {
    const { trace, result } = drive({ succeedOn: 2 });
    await result;
    assert.equal(trace.built.length, 2);
    assert.equal(trace.built[0]?.stopped, true, 'attempt 1 built a client and it was stopped');
  });

  it('does not stop the client it returns', async () => {
    const { trace, result } = drive({ succeedOn: 2 });
    const connected = await result;
    assert.equal(connected, trace.built[1]);
    assert.equal(connected?.stopped, false, 'the published client is the caller’s to stop');
    assert.equal(trace.discarded.length, 1);
  });

  it('leaves nothing alive across a long outage', async () => {
    // The shape of the leak: a hundred failures used to be a hundred live
    // clients on one crypto store. Every one but the last must be stopped.
    const { trace, result } = drive({ succeedOn: 100 });
    const connected = await result;
    assert.equal(trace.built.length, 100);
    assert.equal(trace.discarded.length, 99);
    const alive = trace.built.filter((client) => !client.stopped);
    assert.deepEqual(alive, [connected], 'exactly one client is alive, and it is the one returned');
  });

  it('stops the old client before it builds the next one', async () => {
    // "Two running bots" is the state the crypto store cannot be in, so the
    // order is the property, not merely the count.
    const { trace, result } = drive({ succeedOn: 3 });
    await result;
    assert.deepEqual(trace.events, [
      'build:1',
      'start:1',
      'discard:1@1',
      'sleep:1000',
      'build:2',
      'start:2',
      'discard:2@2',
      'sleep:2000',
      'build:3',
      'start:3',
    ]);
  });

  it('has nothing to stop when construction itself failed', async () => {
    // `resolveDeviceId` runs before `buildBot`, so a whoami that fails leaves
    // no client behind — and a discard here would be a call on undefined.
    const { trace, result } = drive({ succeedOn: 2, failBuildOn: [1] });
    await result;
    assert.equal(trace.discarded.length, 0);
    // The ids count clients, not attempts — attempt 1 never made one.
    assert.deepEqual(trace.events, ['build-throw:1', 'sleep:1000', 'build:1', 'start:1']);
  });
});

describe('AL3 — a shutdown ends the loop, and still ends the client', () => {
  it('stops the client built on the attempt a shutdown arrives on', async () => {
    // The old order was `if (shuttingDown) return;` FIRST, which abandoned the
    // client of the very attempt that was in flight — the one whose Olm state
    // `shutdown()` waits five seconds to flush.
    const { trace, result } = drive({ succeedOn: 99, stopAfter: 1 });
    assert.equal(await result, undefined);
    assert.equal(trace.built.length, 1);
    assert.equal(trace.built[0]?.stopped, true);
  });

  it('does not build one more client after a shutdown during the backoff', async () => {
    // The backoff caps at thirty seconds. A shutdown that lands inside one used
    // to be answered by constructing another client and attempting a login with
    // it; the loop now tests before it builds as well as after it fails.
    const { trace, result } = drive({ succeedOn: 99, stopAfter: 2 });
    assert.equal(await result, undefined);
    assert.equal(trace.built.length, 2, 'the shutdown was seen at the top of attempt 3');
    assert.equal(trace.events.at(-1), 'discard:2@2');
  });
});

describe('AL3 — the loop survives its own teardown failing', () => {
  it('keeps retrying when discard throws', async () => {
    // `discardBot` cannot throw. If it ever does, the throw would be inside a
    // `catch` and would escape — turning "retries forever" into "retries once",
    // which is the failure the loop exists to prevent, reached through its fix.
    const { trace, result } = drive({ succeedOn: 3, discardThrows: true });
    const connected = await result;
    assert.ok(connected, 'a throwing teardown does not end the retry loop');
    assert.equal(trace.built.length, 3);
    assert.deepEqual(trace.errors, [1, 2]);
  });
});

describe('AL3 — the wiring', () => {
  const source = readFileSync(join(PACKAGE_ROOT, 'server', 'src', 'server.ts'), 'utf8');

  it('startMatrix goes through connectWithRetry rather than its own loop', () => {
    const startMatrix = source.slice(source.indexOf('async function startMatrix'));
    const body = startMatrix.slice(0, startMatrix.indexOf('\n}\n'));
    assert.match(body, /connectWithRetry<Bot>\(\{/);
    assert.match(body, /discard: discardBot,/);
    assert.doesNotMatch(body, /for \(let attempt/, 'the hand-rolled loop is gone, not shadowed');
  });

  it('builds the client after the device lookup, so a failed lookup leaks nothing', () => {
    const startMatrix = source.slice(source.indexOf('async function startMatrix'));
    const build = startMatrix.slice(startMatrix.indexOf('build: async'));
    const resolve = build.indexOf('resolveDeviceId()');
    const construct = build.indexOf('buildBot(deviceId)');
    assert.ok(resolve >= 0 && construct > resolve);
  });

  it('registers handlers and logs in on the side that gets discarded', () => {
    // Everything after construction belongs to `start`, because from the moment
    // `build` resolves there is something that has to be stopped.
    const startMatrix = source.slice(source.indexOf('async function startMatrix'));
    const start = startMatrix.slice(startMatrix.indexOf('start: async (candidate)'));
    assert.match(start.slice(0, 400), /registerHandlers\(candidate\)/);
    assert.match(start.slice(0, 400), /candidate\.start\(\)/);
  });

  it('caps the teardown so a hung stop cannot stop the retries', () => {
    const discard = source.slice(source.indexOf('async function discardBot'));
    const body = discard.slice(0, discard.indexOf('\n}\n'));
    assert.match(body, /Promise\.race/);
    assert.match(body, /DISCARD_STOP_MS/);
  });
});
