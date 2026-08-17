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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Must match `server/src/state.ts`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.PRINNY_STATE_DIR ??
    join(env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'channels', 'prinny')
  );
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
 * - `result`  the closing text of each Matrix-originated turn (the default).
 * - `all`     every assistant text message in the turn, as it completes, so the
 *             sender sees progress on a long task instead of silence.
 */
export type ForwardMode = 'off' | 'result' | 'all';

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
  deliverAs: 'followUp',
  forward: 'result',
  permissionMode: 'off',
  permissionTools: [],
  permissionTimeoutSeconds: 300,
  requestTimeoutSeconds: 120,
  connectTimeoutSeconds: 120,
};

const DELIVER_AS: DeliverAs[] = ['followUp', 'steer'];
const FORWARD_MODES: ForwardMode[] = ['off', 'result', 'all'];
const PERMISSION_MODES: PermissionMode[] = ['off', 'dangerous', 'all'];

/**
 * Read the pi-side settings.
 *
 * Anything malformed falls back to the default for that key alone; a typo in
 * one setting must not silently reset the rest, because the rest includes the
 * permission mode.
 */
export function readSettings(file = SETTINGS_FILE): PiSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') raw = parsed;
  } catch {
    // Absent or unreadable: defaults, which are the documented starting state.
  }

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
      const tools = value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
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
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
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
