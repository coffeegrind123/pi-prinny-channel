/**
 * Where the channel keeps its state, and the credentials it boots from.
 *
 * Everything lives under one directory so a second bot on the same machine is
 * a matter of pointing `PRINNY_STATE_DIR` somewhere else — including the
 * crypto store, which must never be shared between two running bots.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `~/.pi/agent/channels/prinny` by default.
 *
 * `PI_CODING_AGENT_DIR` is pi's own override for `~/.pi/agent`, so a pi
 * installation that has been relocated takes the channel's state with it
 * rather than leaving it behind in a directory nothing else uses.
 */
export const STATE_DIR =
  process.env.PRINNY_STATE_DIR ??
  join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
    'channels',
    'prinny'
  );

export const ACCESS_FILE = join(STATE_DIR, 'access.json');
export const APPROVED_DIR = join(STATE_DIR, 'approved');
export const ENV_FILE = join(STATE_DIR, '.env');
export const INBOX_DIR = join(STATE_DIR, 'inbox');
export const PID_FILE = join(STATE_DIR, 'bot.pid');
export const CRYPTO_STORE_PATH = join(STATE_DIR, 'crypto', 'store');
export const CRYPTO_SNAPSHOT_PATH = join(STATE_DIR, 'crypto', 'snapshot.json');

export function log(message: string): void {
  process.stderr.write(`prinny channel: ${message}\n`);
}

/**
 * Load `<state-dir>/.env` into `process.env`, without overriding a real one.
 *
 * A plugin-spawned MCP server inherits no env block of its own, so this file
 * is where the homeserver and credentials actually live.
 */
export function loadEnvFile(): void {
  try {
    // Credentials — lock to the owner. A no-op on Windows, which would need ACLs.
    chmodSync(ENV_FILE, 0o600);
  } catch {
    // Absent or not ours; the read below reports the real problem.
  }
  let raw: string;
  try {
    raw = readFileSync(ENV_FILE, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*(\w+)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const key = match[1]!;
    // Tolerate quoted values — people hand-edit this file.
    const value = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Merge keys into `<state-dir>/.env`, preserving everything else.
 *
 * Used to persist the access token minted by a password login, so the bot
 * stops re-logging-in — and stops minting a new device — on every boot.
 */
export function updateEnvFile(updates: Record<string, string>): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  let lines: string[] = [];
  try {
    lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  } catch {
    // First write.
  }
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  const body = lines.filter((line, i) => line !== '' || i < lines.length - 1).join('\n');
  const tmp = `${ENV_FILE}.tmp`;
  writeFileSync(tmp, `${body.replace(/\n+$/, '')}\n`, { mode: 0o600 });
  renameSync(tmp, ENV_FILE);
}

export type Credentials = {
  homeserverUrl: string;
  userId: string;
  accessToken?: string;
  password?: string;
  deviceId?: string;
  storePassphrase?: string;
  allowUnencrypted: boolean;
};

/**
 * Read credentials from the environment, or explain precisely what is missing.
 *
 * The failure mode this guards against is a server that starts, never
 * connects, and reports nothing — leaving the user staring at a bot that
 * "ignores" them.
 */
export function readCredentials(): { ok: true; value: Credentials } | { ok: false; error: string } {
  const homeserverUrl = process.env.PRINNY_HOMESERVER;
  const userId = process.env.PRINNY_USER_ID;
  const accessToken = process.env.PRINNY_ACCESS_TOKEN;
  const password = process.env.PRINNY_PASSWORD;

  const missing: string[] = [];
  if (!homeserverUrl) missing.push('PRINNY_HOMESERVER (e.g. https://matrix.example.org)');
  if (!userId) missing.push('PRINNY_USER_ID (e.g. @claude:example.org)');
  if (!accessToken && !password) missing.push('PRINNY_PASSWORD, or PRINNY_ACCESS_TOKEN');

  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `missing configuration:\n` +
        missing.map((m) => `  - ${m}\n`).join('') +
        `  set them in ${ENV_FILE}, or run /prinny configure\n`,
    };
  }

  if (userId && !/^@[^:]+:.+$/.test(userId)) {
    return {
      ok: false,
      error: `PRINNY_USER_ID must be a full Matrix ID like @claude:example.org (got "${userId}")\n`,
    };
  }

  return {
    ok: true,
    value: {
      homeserverUrl: homeserverUrl!,
      userId: userId!,
      ...(accessToken ? { accessToken } : {}),
      ...(password ? { password } : {}),
      ...(process.env.PRINNY_DEVICE_ID ? { deviceId: process.env.PRINNY_DEVICE_ID } : {}),
      ...(process.env.PRINNY_STORE_PASSPHRASE
        ? { storePassphrase: process.env.PRINNY_STORE_PASSPHRASE }
        : {}),
      allowUnencrypted: process.env.PRINNY_ALLOW_UNENCRYPTED === '1',
    },
  };
}
