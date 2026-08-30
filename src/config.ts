/**
 * Where the channel's state lives, and the pi-side settings kept beside it.
 *
 * This duplicates `server/src/state.ts`'s directory resolution rather than
 * importing it, and that is deliberate: the server's sources are compiled into
 * a runtime directory outside the repo and are not importable from here without
 * dragging `node_modules` along. The two must agree, so the rule is written out
 * once in each place and asserted by a test.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { stateDir as sharedStateDir } from '../server/bin/agent-dir.mjs';
import { quarantine, readJsonObject, writeJsonAtomic, type LayerStatus } from './json-store.ts';

/**
 * Must match `server/src/state.ts`.
 *
 * AO7: through `server/bin/agent-dir.mjs`, which expands a leading `~` the way
 * pi's own `getAgentDir()` does. This used to be
 * `env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')` — the same
 * expression as the other three readers, and the same one variable short of
 * pi's answer. `server/src/state.ts` cannot import this file (it is compiled
 * into a runtime outside the repo, `rootDir: src`), so it carries the rule again
 * and `tests/config.test.ts` asserts the two agree.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return sharedStateDir(env);
}

export const STATE_DIR = stateDir();
export const ACCESS_FILE = join(STATE_DIR, 'access.json');
export const ENV_FILE = join(STATE_DIR, '.env');

/**
 * The pi-side settings, in their own file rather than inside `access.json`.
 *
 * Tempting as one file is, `access.json` already has a writer: the sidecar
 * rewrites it whenever the gate mints or prunes a pairing, and its
 * `readAccessFile()` rebuilds the object from a fixed list of known keys — so
 * any key it does not know about is dropped on the next pairing. Settings kept
 * there would vanish the first time a stranger messaged the bot, which is about
 * the worst possible time to lose the delivery configuration.
 *
 * Separate files give each one exactly one writer. Access policy is still
 * read-modify-written here for `/prinny allow` and friends, which is the same
 * arrangement the Claude Code skill had.
 */
export const SETTINGS_FILE = join(STATE_DIR, 'pi.json');

/**
 * The channel log.
 *
 * The sidecar talks to its operator on stderr, and in pi both stderr and stdout
 * are the terminal the TUI is drawing on — a single line written there scribbles
 * over the interface. So the child's stderr goes to a file, and only summaries
 * reach the user through `ctx.ui.notify`.
 */
export const LOG_FILE = join(STATE_DIR, 'channel.log');

/**
 * Where the sidecar's dependencies and build output live. Must match
 * `server/bin/prinny-channel.mjs`.
 *
 * The extension needs it to answer one question before spawning anything: has
 * the runtime been prepared? Spawning an unprepared one starts a minute of
 * `npm install` inside a process the connect timeout will kill first, which
 * presents as a channel that never comes up and never says why.
 */
export const RUNTIME_DIR = process.env.PRINNY_RUNTIME_DIR ?? join(STATE_DIR, 'runtime');
export const RUNTIME_ENTRY = join(RUNTIME_DIR, 'dist', 'server.js');
export const RUNTIME_STAMP = join(RUNTIME_DIR, '.source-stamp');

/** How an inbound Matrix message is delivered when pi is mid-stream. */
export type DeliverAs = 'followUp' | 'steer';

/**
 * Which tool calls are relayed to Matrix for approval.
 *
 * pi has no built-in approval prompt — unlike Claude Code, where the channel's
 * permission relay answers prompts the harness raises on its own. Here the
 * extension is the thing that raises them, so the policy has to be stated
 * rather than inherited. Default `off`: adding friction pi does not otherwise
 * have would be a surprise, not a feature.
 */
export type PermissionMode = 'off' | 'dangerous' | 'all';

/**
 * How much of the assistant's output is sent to Matrix without being asked.
 *
 * The Claude Code plugin relied entirely on the model calling a `reply` tool,
 * and at frontier scale that holds. At 27B it does not: the model answers in
 * the transcript and never calls the tool, and the failure is silent — the
 * operator sees a perfectly good answer in the TUI while the person on Matrix
 * sees nothing at all. So forwarding is the default path here, and the tool is
 * what the model uses when it wants to say something *specific* (a quote-reply,
 * an attachment, a second message).
 *
 * What is forwarded is only ever assistant **text**. Thinking blocks and tool
 * calls are excluded — the filter is an allowlist on `type === "text"`, so a
 * content kind added by a future pi is excluded by default rather than leaked.
 *
 * - `off`     nothing is sent unless the model calls `prinny` with action `reply`.
 * - `all`     every assistant text message as it completes (the default), so the
 *             sender follows a long task instead of watching silence for two
 *             minutes. See FORK.md AQ2 for why this is the default and what it
 *             costs.
 * - `result`  everything the model said in that turn, in order, as one message
 *             when the turn settles. One Matrix message and one notification per
 *             turn, and it waits for `agent_settled`, so a retry cannot leave a
 *             superseded intermediate answer standing on somebody's phone.
 * - `last`    only the closing text of the turn. This was `result`'s behaviour
 *             until 2026-08-30, and it loses the answer whenever a turn does not
 *             end on it — a tool call mid-turn is enough, because pi starts a new
 *             assistant message after every one. Kept because it is the narrowest
 *             thing that can reach a stranger, and a session that wants that
 *             should be able to have it. See `runAssistantText` in forwarding.ts
 *             for the measured incident.
 *
 * `result` and `all` carry the same text; they differ in WHEN and in HOW MANY
 * Matrix messages it becomes — `all` streams one per assistant message during
 * the run, `result` sends one message after it settles.
 */
export type ForwardMode = 'off' | 'result' | 'last' | 'all';

export type PiSettings = {
  deliverAs: DeliverAs;
  forward: ForwardMode;
  permissionMode: PermissionMode;
  /** Extra tool names always gated, whatever the mode. */
  permissionTools: string[];
  /** How long a Matrix approval may take before the call is refused. */
  permissionTimeoutSeconds: number;
  /** Seconds before an unanswered tool call to the sidecar gives up. */
  requestTimeoutSeconds: number;
  /**
   * Seconds allowed for the sidecar's MCP handshake.
   *
   * This has to cover a cold Node process importing the Matrix stack, not a
   * round trip. Measured 2026-08-16 in this container: importing the built
   * `server.js` alone takes **27.5s**, and the sidecar answered `initialize` at
   * 17.9s with the Matrix layer arriving 23.6s after that. The old 30s default
   * was therefore a coin flip on an idle box and a certain failure on a busy
   * one — and it fails as `initialize timed out after 30s`, which reads like a
   * broken channel rather than a slow disk.
   *
   * Most of that cost is the runtime living under `~/.pi/agent` on a 9p mount,
   * where thousands of small `node_modules` files are expensive to stat.
   */
  connectTimeoutSeconds: number;
};

export const DEFAULT_SETTINGS: PiSettings = {
  // `steer`, not `followUp`, changed 2026-08-30. `followUp` holds an inbound
  // Matrix message until the agent has finished EVERY tool call, so a
  // correction typed halfway through a ten-call browse lands after the browse
  // is over — by which point it is a comment on history rather than a
  // redirection. The sender is a participant in the conversation, not an
  // audience for it, and the whole reason this channel exists is that they are
  // not sitting at the terminal. Cost: a steer interrupts the loop, and a 27B
  // model that is steered mid-task sometimes drops the original goal. That is a
  // worse failure than a late message on paper and a better one in practice,
  // because it is VISIBLE — the sender sees the model change direction, and can
  // say so.
  deliverAs: 'steer',
  // `all`, not `result`, changed 2026-08-30. See ForwardMode above for what the
  // modes are and FORK.md AQ2 for why the default moved.
  forward: 'all',
  permissionMode: 'off',
  permissionTools: [],
  permissionTimeoutSeconds: 300,
  requestTimeoutSeconds: 120,
  connectTimeoutSeconds: 120,
};

const DELIVER_AS: DeliverAs[] = ['followUp', 'steer'];
const FORWARD_MODES: ForwardMode[] = ['off', 'result', 'last', 'all'];
const PERMISSION_MODES: PermissionMode[] = ['off', 'dangerous', 'all'];

/**
 * Read the pi-side settings.
 *
 * Anything malformed falls back to the default for that key alone; a typo in
 * one setting must not silently reset the rest, because the rest includes the
 * permission mode.
 */
export function readSettings(file = SETTINGS_FILE): PiSettings {
  return readSettingsLayer(file).settings;
}

/**
 * The same read, saying WHICH kind of nothing it found.
 *
 * AN1: the paragraph above is true of a bad VALUE and false of a bad FILE. A
 * missing comma throws out of `JSON.parse`, every key falls to its default, and
 * `permissionMode` goes from `all` to `off` — the Matrix approval relay
 * switched off by a typo, silently. Worse, the next `/prinny set` writes those
 * defaults over the file, so the settings are not merely unread, they are gone.
 *
 * `settingsStatus` is what `/prinny status` prints and what `writeSettings`
 * consults before it replaces anything. See `json-store.ts`.
 */
export function readSettingsLayer(file = SETTINGS_FILE): {
  settings: PiSettings;
  status: LayerStatus;
  error?: string;
} {
  const read = readJsonObject(file);
  const raw: Record<string, unknown> = read.status === 'loaded' ? read.value! : {};
  return { settings: coerceSettings(raw), status: read.status, error: read.error };
}

/** Per-key coercion: a bad value falls back alone, which is the promise above. */
function coerceSettings(raw: Record<string, unknown>): PiSettings {

  const asEnum = <T extends string>(value: unknown, allowed: T[], fallback: T): T =>
    typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;

  const asPositiveInt = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;

  return {
    deliverAs: asEnum(raw.deliverAs, DELIVER_AS, DEFAULT_SETTINGS.deliverAs),
    forward: asEnum(raw.forward, FORWARD_MODES, DEFAULT_SETTINGS.forward),
    permissionMode: asEnum(raw.permissionMode, PERMISSION_MODES, DEFAULT_SETTINGS.permissionMode),
    permissionTools: Array.isArray(raw.permissionTools)
      ? raw.permissionTools.filter((name): name is string => typeof name === 'string')
      : DEFAULT_SETTINGS.permissionTools,
    permissionTimeoutSeconds: asPositiveInt(
      raw.permissionTimeoutSeconds,
      DEFAULT_SETTINGS.permissionTimeoutSeconds
    ),
    requestTimeoutSeconds: asPositiveInt(
      raw.requestTimeoutSeconds,
      DEFAULT_SETTINGS.requestTimeoutSeconds
    ),
    connectTimeoutSeconds: asPositiveInt(
      raw.connectTimeoutSeconds,
      DEFAULT_SETTINGS.connectTimeoutSeconds
    ),
  };
}

export type SettingKey = keyof PiSettings;

export const SETTING_KEYS: SettingKey[] = [
  'deliverAs',
  'forward',
  'permissionMode',
  'permissionTools',
  'permissionTimeoutSeconds',
  'requestTimeoutSeconds',
  'connectTimeoutSeconds',
];

/**
 * Parse one `key value` pair into a typed setting, or explain why not.
 *
 * Returns the parsed value rather than writing it, so the caller can report a
 * bad value without having already half-applied it.
 */
export function parseSetting(
  key: string,
  value: string
): { ok: true; key: SettingKey; value: PiSettings[SettingKey] } | { ok: false; error: string } {
  const bad = (expected: string) => ({
    ok: false as const,
    error: `${key} expects ${expected} (got "${value}")`,
  });

  switch (key) {
    case 'deliverAs':
      return DELIVER_AS.includes(value as DeliverAs)
        ? { ok: true, key, value: value as DeliverAs }
        : bad(DELIVER_AS.join(' | '));
    case 'forward':
      return FORWARD_MODES.includes(value as ForwardMode)
        ? { ok: true, key, value: value as ForwardMode }
        : bad(FORWARD_MODES.join(' | '));
    case 'permissionMode':
      return PERMISSION_MODES.includes(value as PermissionMode)
        ? { ok: true, key, value: value as PermissionMode }
        : bad(PERMISSION_MODES.join(' | '));
    case 'permissionTools': {
      // AO2: de-duplicated by the same question the GATE now asks — see
      // `namesTool` in permission-gate.ts. `bash, Bash` is one instruction, and
      // storing it twice would show the operator a list whose length is a claim
      // about how many tools are gated.
      const seen = new Set<string>();
      const tools: string[] = [];
      for (const name of value.split(',').map((n) => n.trim()).filter(Boolean)) {
        const folded = name.toLowerCase();
        if (seen.has(folded)) continue;
        seen.add(folded);
        tools.push(name);
      }
      return { ok: true, key, value: tools };
    }
    case 'permissionTimeoutSeconds':
    case 'requestTimeoutSeconds':
    case 'connectTimeoutSeconds': {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return bad('a positive number of seconds');
      return { ok: true, key, value: parsed };
    }
    default:
      return {
        ok: false,
        error: `unknown setting "${key}". Known: ${SETTING_KEYS.join(', ')}`,
      };
  }
}

/**
 * Write settings, atomically.
 *
 * Rename rather than truncate-and-write: a crash mid-write would otherwise
 * leave a half-file that reads as "all defaults", quietly turning a configured
 * permission gate back off.
 */
export function writeSettings(settings: PiSettings, file = SETTINGS_FILE): void {
  ensureStateDir(dirname(file));
  // AN1: bytes nobody could read are moved aside before they are replaced.
  // Checked here rather than remembered from the last read, because
  // `readSettings` is called on demand all over this extension and the file may
  // have been hand-edited since — one `statSync`-shaped read is the price.
  const before = readJsonObject(file);
  if (before.status === 'malformed') {
    const moved = quarantine(file);
    process.stderr.write(
      moved
        ? `prinny: ${file} could not be parsed; kept it as ${moved} and started fresh.\n`
        : `prinny: ${file} could not be parsed and could not be moved aside; overwriting it.\n`
    );
  }
  const written = writeJsonAtomic(file, settings);
  if (!written.ok) process.stderr.write(`prinny: could not save ${file}: ${written.error}\n`);
}

/**
 * The env keys `/prinny configure token <t>` has to write — AN3.
 *
 * A Matrix access token belongs to a DEVICE. `PRINNY_DEVICE_ID` is written by
 * whoever minted the last one: a password login through `onCredentials`, or
 * `resolveDeviceId`'s `/account/whoami` lookup. Setting a new token by hand and
 * leaving that key behind hands the next start a device id that belongs to a
 * different token.
 *
 * `resolveDeviceId` reads the stored one FIRST:
 *
 * ```js
 *   async function resolveDeviceId() {
 *     if (creds.deviceId) return creds.deviceId;      // ← never asks
 *     if (!creds.accessToken) return undefined;
 *     …/_matrix/client/v3/account/whoami…
 * ```
 *
 * so the command's own reply — *"The channel resolves the matching device ID
 * from /account/whoami on its next start"* — is false in exactly the case that
 * is normal: a channel that has run before. The bot then builds a Rust-crypto
 * client claiming to be the OLD device while the homeserver considers the token
 * to be a new one, which is the shape of the failure `state.ts` warns about in
 * its own words — a bot that "will appear to ignore people in encrypted rooms",
 * with nothing in the log.
 *
 * And the whoami call is not only a lookup: it is where the token's OWNER is
 * checked (`the access token belongs to X, not PRINNY_USER_ID`). Short-circuited,
 * a token pasted from another account is not caught either.
 *
 * The three-argument `configure` already clears both keys when the user id
 * changes, under the comment *"Replacing the account: the stored token and
 * device belong to the old one"*. This is the same sentence for the token-only
 * arm, which had it too and did not say it.
 *
 * `null` is `updateEnv`'s delete.
 */
export function credentialUpdatesForToken(token: string): Record<string, string | null> {
  return { PRINNY_ACCESS_TOKEN: token, PRINNY_DEVICE_ID: null };
}

/** Whether the channel has credentials at all. Cheap enough to call on demand. */
export function isConfigured(file = ENV_FILE): boolean {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const has = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*\\S`, 'm').test(raw);
  return (
    has('PRINNY_HOMESERVER') &&
    has('PRINNY_USER_ID') &&
    (has('PRINNY_PASSWORD') || has('PRINNY_ACCESS_TOKEN'))
  );
}

export function ensureStateDir(dir = STATE_DIR): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
