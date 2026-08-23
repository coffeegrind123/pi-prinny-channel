/**
 * runtime-stamp.mjs — Forge fork, twenty-third pass (AN2). Is the staged
 * runtime the one this checkout would build?
 *
 * ## The three readers, and the two that could not see a stale build
 *
 * The sidecar runs from a runtime directory outside the repo
 * (`~/.pi/agent/channels/prinny/runtime`), staged and compiled on first use and
 * keyed on a content fingerprint of `server/src` plus the three build files.
 * `prinny-channel.mjs` decides "prepared" as
 *
 * ```js
 *   existsSync(ENTRY) && stampMatches(sourceFingerprint())
 * ```
 *
 * Three other places ask the same question, and until this module they asked a
 * weaker one — `existsSync(dist/server.js)` alone:
 *
 * ```
 *   extensions/index.ts  startupBlocker()   lets a start proceed
 *   extensions/index.ts  /prinny status     prints "runtime: built"
 *   extensions/index.ts  configure          decides whether to run /prinny prepare
 *   scripts/pi-local.sh  the launch line    "run /prinny prepare once (~1 min)"
 * ```
 *
 * All four are the ones that TALK TO THE OPERATOR, and all four read `built` for
 * a runtime whose source has moved on. Measured on this box while the finding
 * was written — not reasoned about:
 *
 * ```
 *   .source-stamp                     f297f2b6…   staged 2026-08-22 14:43
 *   fingerprint of server/src now     53371dab…
 *   staged src/ vs the checkout       connect.ts MISSING, server.ts differs
 * ```
 *
 * So the sidecar in that runtime is the build from before AL3 — the
 * twenty-first pass's fix for a connect loop that builds one matrix-js-sdk
 * client per failed attempt and stops none of them — and every one of those
 * four readers said the runtime was built.
 *
 * ## Why it matters more than "the next start restages it"
 *
 * It does restage, and that is the problem. `npm install` plus `tsc` is about a
 * minute; `connectTimeoutSeconds` is 120 and importing the built sidecar alone
 * costs a measured 27.5 s in this container. The bootstrap's own header names
 * the failure:
 *
 * > The first start has to install dependencies and compile, which takes about
 * > a minute — comfortably past the connect budget the pi extension gives the
 * > child before it declares it dead. That turns setup into a confusing loop of
 * > timeouts. `/prinny prepare` runs this instead, at a point in the flow where
 * > waiting is expected and the output is visible.
 *
 * `--prepare` exists for exactly this, and the guard that routes an operator to
 * it could not see the case that reaches it after the first install. Worse on a
 * box with no registry access, where the restage does not slow the start down,
 * it fails it.
 *
 * ## Why a module with no side effects
 *
 * `prinny-channel.mjs` bootstraps at import — it stages, compiles and then
 * `await import`s the server — so nothing can ask it a question. The fingerprint
 * was therefore unreachable to every other reader, which is why they each
 * invented a weaker one. This file imports node built-ins only, exports
 * functions, and runs nothing; the bootstrap imports it, the extension imports
 * it, and `tests/runtime-stamp.test.ts` drives it.
 *
 * A fourth reader that needs the answer from a shell gets it from
 * `prinny-channel.mjs --staged`, which prints one word and exits 0 for
 * `current`, 1 for `stale`, 2 for `absent`.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Everything the runtime needs to build, beside `src/`. Deliberately small. */
export const STAGED_FILES = ['package.json', 'tsconfig.json', 'tsconfig.build.json']

/** The compiled entry point the bootstrap hands to `await import`. */
export function entryPath(runtimeDir) {
  return join(runtimeDir, 'dist', 'server.js')
}

/** Where the fingerprint of the source that produced that entry is recorded. */
export function stampPath(runtimeDir) {
  return join(runtimeDir, '.source-stamp')
}

/**
 * A fingerprint of the payload source: every staged file and every file under
 * src, hashed by path and **content**.
 *
 * Content rather than mtime, deliberately. A fresh clone, a branch switch and a
 * `git checkout` all rewrite mtimes, so an mtime-based stamp treats each of them
 * as a change and re-runs a minute of installing and compiling for a source tree
 * that is byte-for-byte identical. Hashing ~140KB on each start costs nothing
 * next to that.
 *
 * Unchanged from the version that lived in `prinny-channel.mjs`, down to the
 * `localeCompare` sort — the existing `.source-stamp` files on disk have to keep
 * meaning what they meant, or moving this would itself force a restage.
 */
export function sourceFingerprint(payloadRoot) {
  const hash = createHash('sha256')
  const addFile = (full, label) => {
    hash.update(label)
    hash.update('\0')
    hash.update(readFileSync(full))
    hash.update('\0')
  }
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`)
      else addFile(full, `${prefix}${entry.name}`)
    }
  }
  for (const file of STAGED_FILES) {
    const full = join(payloadRoot, file)
    if (existsSync(full)) addFile(full, file)
  }
  walk(join(payloadRoot, 'src'), 'src/')
  return hash.digest('hex')
}

/** The fingerprint recorded beside a staged runtime, or undefined for none. */
export function readStamp(runtimeDir) {
  try {
    return readFileSync(stampPath(runtimeDir), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * What a staged runtime is, in one word.
 *
 *   absent   nothing compiled: `/prinny prepare` has never run, or the runtime
 *            directory was removed
 *   stale    compiled from source that is no longer what this checkout holds.
 *            A start still works and still ends up correct — it restages first —
 *            but it does so inside the connect budget, which is what `--prepare`
 *            exists to keep it out of
 *   current  the build matches the source
 *
 * `fingerprint` is injectable so a caller that has already computed one (the
 * bootstrap does, immediately before staging) does not pay for it twice.
 */
export function stagedState(runtimeDir, payloadRoot, fingerprint) {
  if (!existsSync(entryPath(runtimeDir))) return 'absent'
  const stamp = readStamp(runtimeDir)
  if (stamp === undefined) return 'stale'
  return stamp === (fingerprint ?? sourceFingerprint(payloadRoot)) ? 'current' : 'stale'
}
