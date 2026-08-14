#!/usr/bin/env node
/**
 * Bootstrap for the Prinny Matrix channel MCP server.
 *
 * This payload is **vendored into a git repository**, and `node_modules` for
 * matrix-js-sdk is ~105MB across ~7,500 files. That cannot live under
 * `vendor/`: it would have to be gitignored (so it is invisible to anyone
 * reviewing what the repo actually ships), it would be wiped by a `git clean`,
 * and on a 9p-backed home directory every tool that walks the tree — ripgrep,
 * the build context sender, pi's own file search — pays for it.
 *
 * So nothing installable lives in the checkout. The checkout carries source
 * only — about a dozen small files — and this stages a *runtime directory*
 * beside the channel's state, outside the repo entirely:
 *
 *     ~/.pi/agent/channels/prinny/runtime/{package.json,src,node_modules,dist}
 *
 * One machine, one dependency tree, however many checkouts or branches exist.
 * The staging is keyed on a fingerprint of the source, so editing the payload
 * recompiles it and an unchanged payload starts instantly.
 *
 * The one rule that never changes: **stdout is the MCP transport.** Every
 * child process below has its stdout wired to *our stderr*, because a single
 * stray line on fd 1 corrupts the JSON-RPC stream and kills the channel with an
 * error that names nothing.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PAYLOAD_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const STATE_DIR =
  process.env.PRINNY_STATE_DIR ??
  join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
    'channels',
    'prinny',
  )

/**
 * Read the channel's own .env early.
 *
 * The server does this too, but the bootstrap needs `PRINNY_BOT_PATH` and
 * `PRINNY_RUNTIME_DIR` *before* it installs anything — and a pi-spawned
 * process inherits no environment block, so this file is the only place those
 * can come from.
 */
for (const line of (() => {
  try {
    return readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')
  } catch {
    return []
  }
})()) {
  const match = /^\s*(\w+)\s*=\s*(.*)$/.exec(line)
  if (!match || line.trimStart().startsWith('#')) continue
  if (process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}

const RUNTIME_DIR = process.env.PRINNY_RUNTIME_DIR ?? join(STATE_DIR, 'runtime')

const STAMP_FILE = join(RUNTIME_DIR, '.source-stamp')
const ENTRY = join(RUNTIME_DIR, 'dist', 'server.js')
const LOCK_DIR = join(RUNTIME_DIR, '.bootstrap.lock')
const LOCK_STALE_MS = 10 * 60 * 1000

/** Everything the runtime needs to build. Deliberately small. */
const STAGED_FILES = ['package.json', 'tsconfig.json', 'tsconfig.build.json']

function log(msg) {
  process.stderr.write(`prinny channel: ${msg}\n`)
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * A fingerprint of the payload source: every staged file and every file under
 * src, hashed by path and **content**.
 *
 * Content rather than mtime, deliberately. A fresh clone, a branch switch and
 * a `git checkout` all rewrite mtimes, so an mtime-based stamp treats each of
 * them as a change and re-runs a minute of installing and compiling for a
 * source tree that is byte-for-byte identical. Hashing ~140KB on each start
 * costs nothing next to that.
 */
function sourceFingerprint() {
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
    const full = join(PAYLOAD_ROOT, file)
    if (existsSync(full)) addFile(full, file)
  }
  walk(join(PAYLOAD_ROOT, 'src'), 'src/')
  return hash.digest('hex')
}

function stampMatches(fingerprint) {
  try {
    return readFileSync(STAMP_FILE, 'utf8') === fingerprint
  } catch {
    return false
  }
}

/** Run a command with stdout redirected to stderr. */
function run(cmd, args, what, cwd = RUNTIME_DIR) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: ['ignore', 2, 2],
    // npm is a .cmd shim on Windows, which CreateProcess cannot exec directly.
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      npm_config_loglevel: 'error',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  })
  if (result.error) throw new Error(`${what} could not run (${cmd}): ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${what} failed with exit code ${result.status}`)
}

/**
 * Cross-process lock, so two pi sessions starting together do not
 * both npm-install into the same tree. mkdir is atomic everywhere we care
 * about; a lock older than LOCK_STALE_MS belonged to a process that died.
 */
/** Is the process that took the lock still alive? */
function lockOwnerAlive() {
  let pid
  try {
    pid = Number.parseInt(readFileSync(join(LOCK_DIR, 'pid'), 'utf8'), 10)
  } catch {
    // No pid recorded — fall back to age alone.
    return Date.now() - mtime(LOCK_DIR) <= LOCK_STALE_MS
  }
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function withLock(fn) {
  const deadline = Date.now() + LOCK_STALE_MS
  let waited = false
  for (;;) {
    try {
      mkdirSync(LOCK_DIR)
      writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid))
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      // A bootstrap killed mid-install — which is exactly what happens when the
      // extension gives up waiting and kills the child — leaves the lock
      // behind. Waiting out a fixed timeout for a process that no longer exists
      // turns one slow start into ten minutes of dead ones.
      if (!lockOwnerAlive()) {
        log('clearing a lock whose owner is gone')
        rmSync(LOCK_DIR, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for another bootstrap to finish')
      if (!waited) {
        // Say so: an unexplained wait is indistinguishable from a hang.
        log('another session is preparing the runtime — waiting')
        waited = true
      }
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { stdio: 'ignore' })
    }
  }
  try {
    return fn()
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true })
  }
}

/**
 * A local @prinny/bot checkout, when one is nearby.
 *
 * Preferred over the published dependency so local changes to the Matrix layer
 * are picked up without a publish round trip. Absent for an ordinary install,
 * where package.json's dependency is used as written.
 *
 * Vendored into a *different* repository than the monorepo it came from, so
 * "sibling" is no longer one fixed level up: the search walks the ancestors of
 * the payload and, at each, tries both a bare `prinny-bot` and the monorepo
 * layout `prinny-mono/prinny-bot`. PRINNY_BOT_PATH short-circuits all of it and
 * is the supported way to pin one.
 */
function siblingBotCheckout() {
  if (process.env.PRINNY_BOT_PATH) return process.env.PRINNY_BOT_PATH
  const roots = []
  for (let dir = PAYLOAD_ROOT; ; dir = dirname(dir)) {
    roots.push(dir)
    if (dirname(dir) === dir) break
  }
  // The home directory is where a checkout most often lives when the vendoring
  // repo is not itself inside the monorepo.
  roots.push(homedir())
  for (const root of roots) {
    for (const candidate of [
      join(root, 'prinny-bot'),
      join(root, 'prinny-mono', 'prinny-bot'),
    ]) {
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  return null
}

function stageRuntime(fingerprint) {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })

  for (const file of STAGED_FILES) {
    const from = join(PAYLOAD_ROOT, file)
    if (existsSync(from)) copyFileSync(from, join(RUNTIME_DIR, file))
  }
  // Replace rather than merge: a file deleted upstream must not survive here
  // and get compiled into the next build.
  rmSync(join(RUNTIME_DIR, 'src'), { recursive: true, force: true })
  cpSync(join(PAYLOAD_ROOT, 'src'), join(RUNTIME_DIR, 'src'), { recursive: true })

  log(`preparing runtime in ${RUNTIME_DIR}`)
  run('npm', ['install', '--no-audit', '--no-fund'], 'npm install')

  const sibling = siblingBotCheckout()
  if (sibling) {
    log(`using the local @prinny/bot checkout at ${sibling}`)
    run('npm', ['install', '--no-save', '--no-audit', '--no-fund', `file:${sibling}`], 'local link')
  }

  // Check the dependency actually arrived with something in it. A git
  // dependency whose repository has no build output installs "successfully"
  // as an empty directory, and the only later symptom is a compile full of
  // "Cannot find module" — or worse, an emitted dist that crashes at import.
  const botEntry = join(RUNTIME_DIR, 'node_modules', '@prinny', 'bot', 'dist', 'index.js')
  if (!existsSync(botEntry)) {
    throw new Error(
      '@prinny/bot installed but has no build output.\n' +
        '  Its package ships `dist/`, which is produced by its `prepare` script — a\n' +
        '  git dependency only builds if that script is committed and pushed.\n' +
        `  Point PRINNY_BOT_PATH at a local checkout in ${join(STATE_DIR, '.env')} to work offline:\n` +
        '    PRINNY_BOT_PATH=/path/to/prinny-bot',
    )
  }

  log('compiling')
  run(
    process.execPath,
    [
      join(RUNTIME_DIR, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      'tsconfig.build.json',
      // Never leave a half-built dist behind: it looks valid to the next start,
      // which then fails at import with an error pointing nowhere near here.
      '--noEmitOnError',
    ],
    'compile',
  )

  writeFileSync(STAMP_FILE, fingerprint)
}

function isStaged() {
  return existsSync(ENTRY) && stampMatches(sourceFingerprint())
}

function bootstrap() {
  const fingerprint = sourceFingerprint()
  if (existsSync(ENTRY) && stampMatches(fingerprint)) return

  // The lock lives inside the runtime dir, so that has to exist before anyone
  // can take it — on a first run it does not.
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })

  withLock(() => {
    // Re-check inside the lock: the session we waited on may have done it.
    if (existsSync(ENTRY) && stampMatches(fingerprint)) return
    stageRuntime(fingerprint)
  })
}

/**
 * `--prepare`: stage the runtime and exit, without starting the server.
 *
 * The first start has to install dependencies and compile, which takes about a
 * minute — comfortably past the connect budget the pi extension gives the
 * child before it declares it dead. That turns setup into a confusing loop of
 * timeouts. `/prinny prepare` runs this instead, at a point in the flow where
 * waiting is expected and the output is visible.
 *
 * Idempotent: staged and unchanged means it returns immediately.
 */
const PREPARE_ONLY = process.argv.includes('--prepare')

if (PREPARE_ONLY) {
  const alreadyStaged = isStaged()
  try {
    bootstrap()
  } catch (err) {
    process.stderr.write(`prinny channel: preparation failed\n\n${err.message}\n\n`)
    process.stderr.write(`  runtime dir: ${RUNTIME_DIR}\n`)
    process.exit(1)
  }
  process.stderr.write(
    alreadyStaged
      ? `prinny channel: runtime already prepared at ${RUNTIME_DIR}\n`
      : `prinny channel: runtime prepared at ${RUNTIME_DIR}\n`,
  )
  process.stderr.write('  the channel will now start within the extension\'s connect budget.\n')
  process.exit(0)
}

try {
  bootstrap()
} catch (err) {
  log(`bootstrap failed: ${err.message}`)
  log(`  runtime dir: ${RUNTIME_DIR}`)
  log(`  to see the full output: cd ${RUNTIME_DIR} && npm install && npx tsc -p tsconfig.build.json`)
  log('  or run this once by hand, where waiting is not fatal:')
  log(`    node ${join(PAYLOAD_ROOT, 'bin', 'prinny-channel.mjs')} --prepare`)
  process.exit(1)
}

await import(pathToFileURL(ENTRY).href)
