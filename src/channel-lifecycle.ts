/**
 * channel-lifecycle.ts — who owns the sidecar between "start it" and "it is up".
 *
 * Forge fork, twenty-second pass (AM1).
 *
 * ## The hole this fills
 *
 * `startChannel` and `stopChannel` are the two halves of one thing, and until
 * this module the only handle they shared was `child` — which is assigned on the
 * line *after* the handshake:
 *
 * ```
 *   starting = (async () => {
 *     try {
 *       await instance.start();      // ← everything below is a different turn
 *       child = instance;            // ← the FIRST moment a stop can see it
 * ```
 *
 * Every line of `stopChannel` reads `child`. So a stop that arrived during the
 * handshake found nothing to stop, ran its teardown against an empty channel,
 * returned, and the sidecar it could not see published itself afterwards.
 *
 * **That window is not measured in microseconds.** The handshake is a fresh
 * `node` importing matrix-js-sdk and its Rust crypto WASM;
 * `src/config.ts`'s own note measures the import at **27.5 s in this container**
 * and sets `connectTimeoutSeconds` to **120** because of it. Four callers land in
 * it:
 *
 * ```
 *   /prinny stop        reported "channel stopped."   the channel came up anyway
 *   /prinny restart     stop + start; the stop did nothing and the start was
 *                       handed the FIRST start's promise, so it reported that
 *                       one's outcome as its own and never restarted
 *   /prinny configure   same shape, with new credentials that were never used —
 *                       and this is the command whose whole job is to replace
 *                       them, run in the session that just started the channel
 *   session_shutdown    `await stopChannel()` returned in milliseconds and left
 *                       a sidecar logging into Matrix for a session that no
 *                       longer exists
 * ```
 *
 * And a disowned sidecar is not inert. It goes on to log in and open the Olm
 * crypto store, which `server/src/state.ts` says
 *
 * > must never be shared between two running bots
 *
 * — so the version of `/prinny restart` that "did nothing" was in fact the one
 * that produced two.
 *
 * ## The rule
 *
 * **A start captures a token; a stop moves it.** The start re-reads the token
 * after every await and refuses to publish itself when it has moved. It is the
 * same mechanism `vendor/pi-loop-mode` calls `runToken` and for the same reason,
 * written down here rather than left implicit in two functions 90 lines apart.
 *
 * A stop does not merely disown: it holds the in-flight instance and **ends it**.
 * Waiting for it instead was the other option and it is the wrong one — the
 * handshake's budget is two minutes and a `session_shutdown` that blocked for
 * two minutes would be worse than the bug. `stop()` on the instance is bounded
 * (SIGTERM, SIGKILL after a grace) and it fails the in-flight `initialize`, so
 * the start's own `catch` runs at once and the awaited promise below returns
 * immediately rather than sitting out its timeout.
 *
 * ## Why it is a module of its own, with no imports
 *
 * So it can be TESTED. `extensions/index.ts` imports `@earendil-works/pi-tui`,
 * `@earendil-works/pi-ai` and `typebox` at runtime, none of which resolve under
 * the bare `node --experimental-strip-types --test` this suite runs on — which
 * is why six suites in `tests/` assert on that file's SOURCE TEXT. The twentieth
 * pass is about exactly that gap, and `server/src/connect.ts` is the precedent:
 * extracted for AL3 so a hundred failing connection attempts could be driven in
 * a millisecond against a fake client that records whether it was stopped. This
 * is the same move on the other side of the pipe.
 */

/** The part of `McpChild` this module needs. Duck-typed so it imports nothing. */
export interface StoppableChannel {
  stop(): Promise<void>;
}

/** What one start does, minus the arbitration. */
export interface StartHooks<T extends StoppableChannel> {
  /** Construct the instance. Called synchronously, before anything can await. */
  build: () => T;
  /** Bring it up. Everything that can take a minute goes here. */
  open: (instance: T) => Promise<void>;
  /** `open` resolved and the token had not moved: this is now the channel. */
  publish: (instance: T) => void;
  /** `open` threw and the token had not moved: this start failed. */
  fail: (instance: T, error: unknown) => void;
  /**
   * The token moved. Told which instance, and the error if `open` also threw —
   * a start the operator cancelled did not *fail*, and the caller says the
   * difference out loud rather than reporting a stop as an error.
   */
  disowned: (instance: T, error?: unknown) => void;
}

/**
 * The arbiter between one start and one stop.
 *
 * Holds three things — the token, the promise of the start in flight, and the
 * instance that start is bringing up — because all three are needed to answer
 * the two questions, and holding two of them was the bug.
 */
export class ChannelLifecycle<T extends StoppableChannel> {
  /**
   * Moved by every `cancel()`. A start compares it to the value it captured.
   *
   * Monotonic, like `runToken`: the question is never "how many stops" but
   * "is this still the same one", and a counter answers that without a reset
   * that could itself be missed.
   */
  private token = 0;

  private inFlight: { token: number; instance: T; promise: Promise<void> } | null = null;

  /** True while a start is between `build()` and its outcome. */
  get starting(): boolean {
    return this.inFlight !== null;
  }

  /** The instance a start is bringing up, for a caller that wants to report it. */
  get pendingInstance(): T | undefined {
    return this.inFlight?.instance;
  }

  /**
   * Run one start, or join the one already running.
   *
   * Joining rather than starting a second is what `startChannel`'s
   * `if (starting) return starting` has always done, and it stays: two sidecars
   * on one crypto store is the failure this whole file is about.
   */
  start(hooks: StartHooks<T>): Promise<void> {
    if (this.inFlight) return this.inFlight.promise;

    const token = this.token;
    const instance = hooks.build();

    const promise = (async () => {
      try {
        await hooks.open(instance);
        // Re-read, because everything above happened in somebody else's turn.
        if (this.token !== token) {
          // `cancel()` has already stopped it; this call is the belt to that
          // brace, and is a no-op on an instance whose `stop()` has run.
          await instance.stop().catch(() => undefined);
          hooks.disowned(instance);
          return;
        }
        hooks.publish(instance);
      } catch (error) {
        await instance.stop().catch(() => undefined);
        if (this.token !== token) {
          hooks.disowned(instance, error);
          return;
        }
        hooks.fail(instance, error);
      } finally {
        // Only if it is still ours. A `cancel()` has already cleared it, and a
        // LATER start may have installed its own — clearing that one would
        // orphan a start nobody can join.
        if (this.inFlight?.token === token) this.inFlight = null;
      }
    })();

    this.inFlight = { token, instance, promise };
    return promise;
  }

  /**
   * Disown whatever is starting, end it, and wait for it to settle.
   *
   * Returns immediately when nothing is in flight, which is the ordinary case.
   * Bounded by the instance's own `stop()` — see the header for why this ends
   * the start rather than waiting for it.
   */
  async cancel(): Promise<void> {
    this.token += 1;
    const pending = this.inFlight;
    this.inFlight = null;
    if (!pending) return;
    await pending.instance.stop().catch(() => undefined);
    // With its transport dead the start's own `catch` runs at once, so this is
    // the teardown finishing rather than the timeout being sat out. Awaited so a
    // caller that stops and starts in two statements — `/prinny restart`,
    // `/prinny configure` — cannot have the second race the first.
    await pending.promise.catch(() => undefined);
  }
}
