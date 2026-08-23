/**
 * agent-dir.mjs — where pi keeps its own directory, for everything in this
 * package that has to agree with pi about it.
 *
 * ## Why this file exists (AO7, twenty-fourth pass)
 *
 * `PI_CODING_AGENT_DIR` is pi's `ENV_AGENT_DIR`, and this package reads it in
 * four places: `src/config.ts`, `server/src/state.ts`,
 * `server/bin/prinny-channel.mjs` and `tests/harness.ts`. All four wrote the
 * same expression:
 *
 * ```js
 *   env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
 * ```
 *
 * and pi's own `getAgentDir()` (dist/config.js) is
 *
 * ```js
 *   const envDir = process.env[ENV_AGENT_DIR];
 *   if (envDir) return expandTildePath(envDir);
 *   return join(homedir(), CONFIG_DIR_NAME, "agent");
 * ```
 *
 * The difference is `expandTildePath`, and it is not decorative.
 * `PI_CODING_AGENT_DIR=~/pi-work` is an ordinary thing to write in a shell
 * profile or an `.env`, and it does not get expanded by the shell when it is
 * quoted or when it is read out of a file. pi then keeps its files in
 * `$HOME/pi-work` and this package keeps the channel's state, its credentials
 * and its crypto store in a directory literally named `~` — RELATIVE TO
 * WHATEVER THE CWD IS, so a second session started somewhere else gets a second
 * empty one. Everything works, and the bot has no allowlist and no keys.
 *
 * `vendor/pi-subagents-lite/src/agent-dir.ts` answers the same question for the
 * other package. The two cannot import each other, so the rule is written twice
 * and `tests/config.test.ts` asserts they agree — the same arrangement the
 * compaction lock and `json-store.ts` already have here.
 *
 * ## The tilde rule
 *
 * Read out of pi's `normalizePath` (`dist/utils/paths.js`) rather than guessed,
 * down to the backslash form being win32-only:
 *
 * ```js
 *   if (normalized === "~") return home;
 *   if (normalized.startsWith("~/") ||
 *       (process.platform === "win32" && normalized.startsWith("~\\"))) { … }
 * ```
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** pi's override for its own agent directory. Must match pi's `ENV_AGENT_DIR`. */
export const ENV_AGENT_DIR = 'PI_CODING_AGENT_DIR'

/** `~` and `~/…` expanded the way pi's `expandTildePath` does; anything else untouched. */
export function expandTilde(path) {
  if (path === '~') return homedir()
  const separated = path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))
  return separated ? join(homedir(), path.slice(2)) : path
}

/** Where pi keeps `settings.json`, `sessions/`, `channels/` and the rest. */
export function agentDir(env = process.env) {
  const override = env[ENV_AGENT_DIR]
  if (override) return expandTilde(override)
  return join(homedir(), '.pi', 'agent')
}

/** `<agent dir>/channels/prinny`, unless `PRINNY_STATE_DIR` names one outright. */
export function stateDir(env = process.env) {
  return env.PRINNY_STATE_DIR ?? join(agentDir(env), 'channels', 'prinny')
}
