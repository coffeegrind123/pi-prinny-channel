/**
 * session-scope.ts — which teardowns end the CHANNEL, and which only end a SESSION.
 *
 * Forge fork, twenty-third pass (AP1).
 *
 * ## The hole this fills
 *
 * `session_shutdown` had one handler and it did one thing:
 *
 * ```
 *   pi.on('session_shutdown', async () => {
 *     await stopChannel();
 *   });
 * ```
 *
 * The event carries a `reason`, and that handler never read it. Five different
 * things arrive through it — `quit`, `reload`, `new`, `resume`, `fork` — and only
 * the first is the process going away. The other four are pi REPLACING the
 * session inside a process that is still running, and for all four the channel
 * was torn down and rebuilt from nothing.
 *
 * What that costs on `/new`, measured on this box rather than reasoned about:
 * the sidecar is SIGTERM'd, the Matrix client logs out, the Olm store closes,
 * and the replacement spends **27.5 s importing matrix-js-sdk** before it can
 * even hand shake (`src/config.ts` sets `connectTimeoutSeconds` to 120 for that
 * reason). Reproduced with a stand-in sidecar delayed to the real import cost:
 * `/new` put the channel down for 25.1 s, with the status pill reading
 * `prinny: stopped` and then `prinny: starting` for the whole of it. A `/new` is
 * a *keystroke*. Nothing about it is a reason to log a bot out of Matrix.
 *
 * And the outage is the mild half. The sidecar owns the Olm crypto store, which
 * `server/src/state.ts` says
 *
 * > must never be shared between two running bots
 *
 * so every replacement is another close/reopen of the one piece of state in this
 * system that cannot be repaired, only re-minted — for a conversation reset that
 * has nothing to do with Matrix.
 *
 * ## The rule, and why `reload` is on the other side of it
 *
 * The dividing question is not "is this a teardown" but **"does the module that
 * holds the sidecar handle survive it"**. `child` and `lifecycle` are
 * module-level in `extensions/index.ts`. If the module is re-evaluated, the new
 * instance's `child` is `null` and the sidecar it can no longer reach goes on
 * running — which is AM1's disaster reached by a different road, and worse,
 * because the replacement then spawns a SECOND bot onto the same crypto store
 * and `server/src/account-lock.ts` refuses it. The channel would be dead until
 * the process restarted.
 *
 * So the rule was measured, not assumed, against pi's own extension loader:
 *
 * ```
 *   loadExtensionModule(path, cacheToken)
 *     isCurrentCacheToken(cacheToken) -> return extensionCache.get(path)
 *     otherwise -> fresh jiti, moduleCache: false, re-evaluate
 * ```
 *
 * `clearExtensionCache()` bumps the generation that `isCurrentCacheToken`
 * compares, and it has exactly one caller: `ResourceLoader.reload()`. That is
 * `/reload`, and nothing else.
 *
 *   new | resume | fork   cache token unchanged -> the SAME module instance is
 *                         handed to the replacement session. Confirmed by probe
 *                         against a real pi in `--mode rpc`: one `module
 *                         evaluated` line for three `new_session` commands, with
 *                         a module-scoped counter running 1..5 across them.
 *                         -> DETACH: release the session's state, keep the bot.
 *
 *   reload                `clearExtensionCache()` -> the module is re-evaluated
 *                         and every module-level binding in this extension is a
 *                         fresh one.
 *                         -> STOP. A detach here orphans the sidecar.
 *
 *   quit                  the process is going.
 *                         -> STOP.
 *
 * Anything unrecognised is STOP, which is what the code did before this module
 * existed. A reason pi adds later should cost a channel restart, not a second
 * bot on the crypto store: the failure of guessing wrong in this direction is
 * thirty seconds, and in the other direction it is unrepairable key state.
 *
 * ## Why it is a module of its own
 *
 * Same argument as `channel-lifecycle.ts`, in the same words, because it is the
 * same constraint: `extensions/index.ts` imports `@earendil-works/pi-tui`,
 * `@earendil-works/pi-ai` and `typebox`, none of which resolve under the bare
 * `node --experimental-strip-types --test` this suite runs on. A rule that lives
 * in that file can only be tested by asserting on its source TEXT. A rule that
 * lives here can be tested.
 */

/** The reasons pi documents for `session_shutdown`. Others are possible. */
export type ShutdownReason = 'quit' | 'reload' | 'new' | 'resume' | 'fork';

/** The reasons pi documents for `session_start`. Others are possible. */
export type StartReason = 'startup' | 'reload' | 'new' | 'resume' | 'fork';

/**
 * `stop` ends the sidecar. `detach` releases only what belonged to the session
 * that is going and leaves the bot logged in.
 */
export type ShutdownDisposition = 'stop' | 'detach';

/**
 * The reasons for which pi hands the replacement session THE SAME module
 * instance, so a detach can still reach the sidecar afterwards.
 *
 * Exported so a test can state the list rather than restate the function.
 */
export const SESSION_REPLACEMENT_REASONS: readonly string[] = ['new', 'resume', 'fork'];

/**
 * What a `session_shutdown` with this reason should do to the channel.
 *
 * Defaults to `stop` for anything not on the list above — including
 * `undefined`, which is what an older pi that does not populate `reason` would
 * give, and which must not be read as permission to keep a sidecar the next
 * module instance cannot see.
 */
export function shutdownDisposition(reason: unknown): ShutdownDisposition {
  return typeof reason === 'string' && SESSION_REPLACEMENT_REASONS.includes(reason)
    ? 'detach'
    : 'stop';
}

/**
 * Whether a `session_start` is the far side of a detach rather than a cold open.
 *
 * `channelRunning` is the second half deliberately: the reason alone does not
 * settle it. A `session_start` with reason `new` arrives on a channel that is
 * still up (the ordinary case, now that the shutdown detached) and on one that
 * is not (the sidecar exited on its own between the two events, or it never
 * came up because the homeserver is down). Only the first is a reattach; the
 * second has to start a channel like any other.
 */
export function startDisposition(
  reason: unknown,
  channelRunning: boolean
): 'start' | 'reattach' {
  if (!channelRunning) return 'start';
  return typeof reason === 'string' && SESSION_REPLACEMENT_REASONS.includes(reason)
    ? 'reattach'
    : 'start';
}

/**
 * What a Matrix sender is told when the session that owed them an answer was
 * replaced before it gave one.
 *
 * The three neighbours of this sentence are `undeliveredMessage`,
 * `unansweredMessage` and `abandonedCompactionMessage`, and it is written to the
 * same rule they are: say what is known, name the action that is always right,
 * and do not invent a cause. What is known here is exact — the extension is the
 * thing performing the replacement, so unlike the undelivered sweep it is not
 * guessing.
 *
 * It does NOT say "ask again once I am back", which is
 * `abandonedCompactionMessage`'s ending, because after a detach the bot never
 * went anywhere: the channel is up and the next message will be taken. Telling
 * someone to wait for a return that already happened would send them away from a
 * working bot.
 */
export function replacedSessionMessage(): string {
  return (
    'The session I handed that to was replaced before it answered, so that answer is not coming. ' +
    'Nothing is waiting on my side and I am still here — please ask again.'
  );
}
