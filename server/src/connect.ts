/**
 * Connect with retry, and never leave a client behind.
 *
 * ## The hole this fills
 *
 * Forge fork, twenty-first pass (AL3). `startMatrix` retries the homeserver
 * **forever**, on purpose, and says why: *"a homeserver that comes back should
 * not need the user to restart pi"*. That is the right trade. The loop it was
 * written as was:
 *
 * ```
 *   for (let attempt = 1; ; attempt += 1) {
 *     try {
 *       const next = buildBot(await resolveDeviceId());   // ← a NEW client
 *       registerHandlers(next);
 *       await next.setMyCommands(COMMANDS);
 *       await next.start();                               // ← may throw here
 *       bot = next;
 *       return;
 *     } catch (err) {
 *       if (shuttingDown) return;                         // ← and here
 *       await sleep(Math.min(1000 * attempt, 30_000));
 *     }
 *   }
 * ```
 *
 * Every attempt CONSTRUCTS a client and no path STOPS one. `buildBot` is not a
 * cheap object: it is a matrix-js-sdk client with Rust crypto behind it, and
 * `server/src/state.ts` — the file that hands `buildBot` the path it opens —
 * opens with the sentence this loop makes false:
 *
 * > Everything lives under one directory so a second bot on the same machine
 * > is a matter of pointing `PRINNY_STATE_DIR` somewhere else — **including the
 * > crypto store, which must never be shared between two running bots.**
 *
 * Attempt 2 builds a second client on `CRYPTO_STORE_PATH` while attempt 1's is
 * still holding it. Attempt 3 makes three. The backoff caps at 30 s, so an
 * overnight homeserver outage is of the order of a thousand of them, each with
 * its own handlers, its own timers and its own claim on one crypto store.
 *
 * And the failure this loop exists for is the one that reaches it: `start()` is
 * where a login is attempted, so a wrong password, an expired token, a 502 from
 * a reverse proxy and an unreachable host all arrive here — after construction,
 * which is the only point at which there is something to leak.
 *
 * The control is one package away and gets it right. The EXTENSION's
 * `startChannel` wraps the same shape:
 *
 * ```
 *   } catch (err) {
 *     …
 *     await instance.stop().catch(() => undefined);
 *     child = null;
 *   }
 * ```
 *
 * Same author, same repository, same week; the difference is that
 * `startChannel` runs once and this one runs forever, which is exactly
 * backwards from where the care was needed.
 *
 * ## Why it is a module of its own, with no imports
 *
 * So it can be TESTED. `server/src/server.ts` boots a sidecar at import: it
 * reads credentials, opens an MCP transport on fd 1 and installs signal
 * handlers, so a test cannot load it, and the only assertions that had ever
 * been made about `startMatrix` were assertions about its SOURCE TEXT. The
 * twentieth pass is about exactly that gap between a name and its test.
 *
 * This file imports nothing — not even `./state.js` — so `tests/connect.test.ts`
 * can import the `.ts` directly under `--experimental-strip-types` and drive a
 * hundred failing attempts in a millisecond with a fake client that records
 * whether it was stopped. (A sibling import would defeat that: Node does not
 * resolve a `./state.js` specifier to `state.ts`, measured, so a module in this
 * directory is reachable from a test only if it stands alone.)
 */

/** What one attempt needs, and what to do with the wreckage of a failed one. */
export interface ConnectHooks<T> {
  /**
   * Construct one client. Nothing is owned until this RESOLVES: if it throws
   * there is nothing to discard, which is why the device-ID lookup belongs in
   * here and the login does not.
   */
  build: (attempt: number) => Promise<T> | T;
  /**
   * Bring the client the `build` above returned all the way up. Everything from
   * handler registration to the login goes here, because from the moment
   * `build` resolved there is something that has to be stopped.
   */
  start: (client: T, attempt: number) => Promise<void>;
  /**
   * Stop a client this loop built and will not publish.
   *
   * Must not throw and must not hang: it is on the retry path, so a `stop()`
   * that never settles would turn "retry forever" into "retry never" — the
   * failure mode the loop was written to avoid, reached through its own repair.
   */
  discard: (client: T, attempt: number) => Promise<void>;
  /** Backoff before attempt n+1. */
  delayMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
  /** Told about every failed attempt, with the delay that follows it. */
  onError: (attempt: number, err: unknown, delayMs: number) => void;
  /**
   * True once the process is going away.
   *
   * Read in two places, and the second one is not decoration: the backoff is up
   * to thirty seconds, and a shutdown that arrives inside one used to be
   * answered by building one more client and trying to log it in.
   */
  stopping: () => boolean;
}

/**
 * Attempt after attempt until one client is fully up, and return it.
 *
 * Returns `undefined` — and only then — when `stopping()` says the process is
 * going away. There is no other exit: that is the "retries forever" contract,
 * kept.
 *
 * The caller publishes what it gets back. This loop deliberately never assigns
 * the client anywhere: a half-constructed client that is reachable is worse
 * than one that is merely alive, and "published only once `start()` resolves"
 * is a property `startMatrix` already had and keeps.
 */
export async function connectWithRetry<T>(hooks: ConnectHooks<T>): Promise<T | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    if (hooks.stopping()) return undefined;
    let candidate: T | undefined;
    try {
      candidate = await hooks.build(attempt);
      await hooks.start(candidate, attempt);
      const connected = candidate;
      // Ownership passes to the caller on this line, and the `catch` below
      // must not stop what it is about to publish.
      candidate = undefined;
      return connected;
    } catch (err) {
      // AL3. Before the `stopping()` test, not after: a client built during a
      // shutdown still holds the crypto store, and `shutdown()`'s whole reason
      // for waiting on `stop()` is that losing the last minutes of Olm state
      // forces every peer to re-key.
      if (candidate !== undefined) {
        try {
          await hooks.discard(candidate, attempt);
        } catch {
          // The contract above says this cannot happen, and `discardBot` is
          // written so that it cannot. If it does anyway, the throw is inside a
          // `catch` and would escape the loop — turning "retries forever" into
          // "retries once", which is the failure this whole function exists to
          // prevent, reached through its own repair. The teardown already
          // reports itself; losing that report costs less than losing the loop.
        }
      }
      if (hooks.stopping()) return undefined;
      const delay = hooks.delayMs(attempt);
      hooks.onError(attempt, err, delay);
      await hooks.sleep(delay);
    }
  }
}
