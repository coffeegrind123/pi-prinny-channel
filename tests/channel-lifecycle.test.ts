/**
 * AM1 — the stop that could not see the start.
 *
 * `startChannel` assigned `child` on the line AFTER `await instance.start()`,
 * and every line of `stopChannel` reads `child`. So for the whole of the
 * handshake — a fresh node importing matrix-js-sdk and its Rust crypto WASM,
 * measured at 27.5 s in this container, budgeted at 120 s — a stop found nothing
 * to stop, ran its teardown against an empty channel, returned, and the sidecar
 * it could not see published itself afterwards.
 *
 * Four callers land in that window: `/prinny stop`, `/prinny restart`,
 * `/prinny configure` and `session_shutdown`. The last two are the ones that
 * matter most — `configure` exists to REPLACE the credentials the in-flight
 * start is using, and `session_shutdown` left a sidecar logging into Matrix for
 * a session that no longer exists, on the Olm crypto store
 * `server/src/state.ts` says "must never be shared between two running bots".
 *
 * The rules under test are `ChannelLifecycle`'s, driven with a fake instance
 * that records whether it was stopped — the same shape `connect.test.ts` uses
 * for AL3 on the other side of the pipe.
 */

import { describe, expect, it } from './harness.ts';
import { ChannelLifecycle } from '../src/channel-lifecycle.ts';

/** A sidecar stand-in: opens when it is told to, and remembers being stopped. */
class FakeChannel {
  stopped = 0;
  /**
   * `McpChild.stop()` opens `if (!child || this.closed) return;`, so a second
   * stop is a no-op there and has to be one here — otherwise the count below
   * measures how many times the code asked rather than how many sidecars ended,
   * and the belt-and-braces stop inside `ChannelLifecycle` reads as a bug.
   */
  private closed = false;
  // An explicit field, not a parameter property: strip-only type stripping
  // refuses `constructor(readonly id: number)` outright
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), which is the same constraint
  // `src/mcp-stdio.ts` records for `McpChild`'s own options field.
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopped += 1;
  }
}

interface Recorder {
  built: FakeChannel[];
  published: FakeChannel[];
  failed: Array<{ instance: FakeChannel; error: unknown }>;
  disowned: Array<{ instance: FakeChannel; error: unknown }>;
}

function recorder(): Recorder {
  return { built: [], published: [], failed: [], disowned: [] };
}

/** A start whose `open` resolves only when the test says so. */
function gatedHooks(rec: Recorder, outcome: 'resolve' | 'reject' = 'resolve') {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hooks = {
    build: () => {
      const instance = new FakeChannel(rec.built.length + 1);
      rec.built.push(instance);
      return instance;
    },
    open: async () => {
      await opened;
      if (outcome === 'reject') throw new Error('handshake failed');
    },
    publish: (instance: FakeChannel) => {
      rec.published.push(instance);
    },
    fail: (instance: FakeChannel, error: unknown) => {
      rec.failed.push({ instance, error });
    },
    disowned: (instance: FakeChannel, error?: unknown) => {
      rec.disowned.push({ instance, error });
    },
  };
  return { hooks, release };
}

describe('AM1 — a stop that arrives during a start', () => {
  it('ends the instance the start is bringing up', async () => {
    const rec = recorder();
    const lifecycle = new ChannelLifecycle<FakeChannel>();
    const { hooks, release } = gatedHooks(rec);

    const started = lifecycle.start(hooks);
    expect(lifecycle.starting).toBe(true);
    expect(rec.built).toHaveLength(1);

    // The stop lands while the handshake is still in flight. Before AM1 this
    // could not see the instance at all.
    const stopped = lifecycle.cancel();
    release();
    await stopped;
    await started;

    expect(rec.built[0].stopped).toBe(1);
  });

  it('does not publish the sidecar it disowned', async () => {
    const rec = recorder();
    const lifecycle = new ChannelLifecycle<FakeChannel>();
    const { hooks, release } = gatedHooks(rec);

    const started = lifecycle.start(hooks);
    const stopped = lifecycle.cancel();
    release();
    await stopped;
    await started;

    // The whole finding: `publish` is what assigns `child`, and it used to run
    // regardless.
    expect(rec.published).toHaveLength(0);
    expect(rec.disowned).toHaveLength(1);
    expect(rec.disowned[0].instance.id).toBe(1);
  });

  it('reports a stopped start as stopped, not as a failure', async () => {
    const rec = recorder();
    const lifecycle = new ChannelLifecycle<FakeChannel>();
    const { hooks, release } = gatedHooks(rec, 'reject');

    const started = lifecycle.start(hooks);
    const stopped = lifecycle.cancel();
    release();
    await stopped;
    await started;

    // `fail` sets `lastError`, which `/prinny status` repeats and
    // `requireChannel()` quotes, and nulls `child` — which would drop a sidecar
    // a later start has already published.
    expect(rec.failed).toHaveLength(0);
    expect(rec.disowned).toHaveLength(1);
    expect(String(rec.disowned[0].error)).toContain('handshake failed');
  });

  it('lets the next start build a NEW sidecar — the /prinny restart shape', async () => {
    const rec = recorder();
    const lifecycle = new ChannelLifecycle<FakeChannel>();
    const first = gatedHooks(rec);

    const started = lifecycle.start(first.hooks);
    // `/prinny restart` is `await stopChannel(); await startChannel();`. The
    // stop used to do nothing and the start used to be handed the FIRST start's
    // promise — so restart reported that one's outcome as its own and never
    // restarted anything.
    const stopped = lifecycle.cancel();
    first.release();
    await stopped;
    await started;

    expect(lifecycle.starting).toBe(false);

    const second = gatedHooks(rec);
    const restarted = lifecycle.start(second.hooks);
    second.release();
    await restarted;

    expect(rec.built).toHaveLength(2);
    expect(rec.published).toHaveLength(1);
    expect(rec.published[0].id).toBe(2);
  });

  it('cancel() waits for the start it cancelled to settle', async () => {
    const rec = recorder();
    const lifecycle = new ChannelLifecycle<FakeChannel>();
    const { hooks, release } = gatedHooks(rec);

    const started = lifecycle.start(hooks);
    let settled = false;
    void started.then(() => {
      settled = true;
    });

    const stopped = lifecycle.cancel();
    release();
    await stopped;

    // The await is what stops `/prinny configure`'s start from racing its own
    // stop's teardown.
    expect(settled).toBe(true);
  });

  it('does not orphan a later start when an earlier disowned one settles', async () => {
    const rec = recorder();
    const lifecycle = new ChannelLifecycle<FakeChannel>();
    const first = gatedHooks(rec);

    const started = lifecycle.start(first.hooks);
    // Cancel WITHOUT releasing: the first start is still suspended in `open`.
    const stopped = lifecycle.cancel();

    const second = gatedHooks(rec);
    const restarted = lifecycle.start(second.hooks);
    expect(lifecycle.starting).toBe(true);
    expect(lifecycle.pendingInstance?.id).toBe(2);

    // Now let the FIRST one finish. Its `finally` must not clear the second's
    // slot — a start nobody can join is a channel that can never be stopped.
    first.release();
    await stopped;
    await started;
    expect(lifecycle.starting).toBe(true);
    expect(lifecycle.pendingInstance?.id).toBe(2);

    second.release();
    await restarted;
    expect(rec.published).toHaveLength(1);
    expect(rec.published[0].id).toBe(2);
  });
});

describe('AM1 — controls: the behaviour that must not change', () => {
  it('publishes a start that nothing stopped', async () => {
    const rec = recorder();
    const lifecycle = new ChannelLifecycle<FakeChannel>();
    const { hooks, release } = gatedHooks(rec);

    const started = lifecycle.start(hooks);
    release();
    await started;

    expect(rec.published).toHaveLength(1);
    expect(rec.disowned).toHaveLength(0);
    expect(rec.built[0].stopped).toBe(0);
    expect(lifecycle.starting).toBe(false);
  });

  it('reports a genuine handshake failure as a failure', async () => {
    const rec = recorder();
    const lifecycle = new ChannelLifecycle<FakeChannel>();
    const { hooks, release } = gatedHooks(rec, 'reject');

    const started = lifecycle.start(hooks);
    release();
    await started;

    expect(rec.failed).toHaveLength(1);
    expect(rec.disowned).toHaveLength(0);
    // The failed instance is still stopped: a half-built sidecar holds the
    // crypto store exactly like a working one. AL3's rule, one package over.
    expect(rec.built[0].stopped).toBe(1);
  });

  it('joins a start already in flight rather than building a second sidecar', async () => {
    const rec = recorder();
    const lifecycle = new ChannelLifecycle<FakeChannel>();
    const { hooks, release } = gatedHooks(rec);

    const a = lifecycle.start(hooks);
    const b = lifecycle.start(hooks);
    expect(a).toBe(b);
    expect(rec.built).toHaveLength(1);

    release();
    await a;
    expect(rec.published).toHaveLength(1);
  });

  it('cancel() with nothing in flight is a no-op', async () => {
    const lifecycle = new ChannelLifecycle<FakeChannel>();
    await lifecycle.cancel();
    expect(lifecycle.starting).toBe(false);
    expect(lifecycle.pendingInstance).toBeUndefined();
  });
});
