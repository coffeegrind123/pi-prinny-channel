/**
 * Reading and editing `access.json` from the extension.
 *
 * In Claude Code this was a skill: a Markdown file telling the model to read
 * some JSON, mutate it carefully, and write it back. That works at frontier
 * scale and is a liability at 27B — a dropped key or a re-serialised
 * `pending` block is a silently broken allowlist, and the allowlist is the
 * only thing between a public Matrix ID and a shell. So the mutations are code
 * here, and the skill is reduced to explaining which command to run.
 *
 * The file format is the sidecar's, unchanged, and every write is
 * read-modify-write onto whatever is currently on disk: the sidecar adds
 * `pending` entries underneath us whenever a stranger messages the bot, and a
 * blind write would clobber a pairing the user is halfway through approving.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ACCESS_FILE, STATE_DIR } from './config.ts';

export type PendingEntry = {
  senderId: string;
  roomId: string;
  createdAt: number;
  expiresAt: number;
  replies: number;
};

export type RoomPolicy = {
  requireMention: boolean;
  allowFrom: string[];
};

export type DmPolicy = 'pairing' | 'allowlist' | 'disabled';

export type Access = {
  dmPolicy: DmPolicy;
  allowFrom: string[];
  rooms: Record<string, RoomPolicy>;
  pending: Record<string, PendingEntry>;
  mentionPatterns?: string[];
  ackReaction?: string;
  replyToMode?: 'off' | 'first' | 'all';
  textChunkLimit?: number;
  format?: 'markdown' | 'text';
  notice?: boolean;
  autoJoinUnknown?: boolean;
};

export const DM_POLICIES: DmPolicy[] = ['pairing', 'allowlist', 'disabled'];

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], rooms: {}, pending: {} };
}

/** A full Matrix ID. A bare localpart in the allowlist silently matches nobody. */
export const MXID_RE = /^@[^:\s]+:[^\s:]+(:\d+)?$/;

/** A room ID, not an alias: an alias moves between rooms, an ID does not. */
export const ROOM_ID_RE = /^![^:\s]+:[^\s]+$/;

export function readAccess(file = ACCESS_FILE): Access {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess();
    throw err;
  }
  let parsed: Partial<Access>;
  try {
    parsed = JSON.parse(raw) as Partial<Access>;
  } catch {
    // Do not quarantine it here. The sidecar already does that on its own read,
    // with a log line; a second process racing to rename the same file turns
    // one recoverable corruption into two half-corruptions.
    throw new Error(
      `${file} is not valid JSON. The channel will move it aside on its next ` +
        'read and start from defaults; fix or delete it if that is not what you want.'
    );
  }
  return {
    ...parsed,
    dmPolicy: parsed.dmPolicy ?? 'pairing',
    allowFrom: parsed.allowFrom ?? [],
    rooms: parsed.rooms ?? {},
    pending: parsed.pending ?? {},
  };
}

export function writeAccess(access: Access, file = ACCESS_FILE): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  // Pretty-printed on purpose: this file is meant to survive a hand-edit.
  writeFileSync(tmp, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Is `key` actually IN this record? — AO6, twenty-fourth pass.
 *
 * `access.pending`, `access.rooms` and every other `Record<string, …>` here
 * comes out of `JSON.parse`, so it carries `Object.prototype`, and a plain
 * `obj[key]` answers for eight keys nobody ever stored:
 *
 * ```
 *   constructor  toString  valueOf  hasOwnProperty
 *   __proto__    isPrototypeOf  propertyIsEnumerable  toLocaleString
 * ```
 *
 * Every one of them is truthy. `pair('constructor')` therefore found an
 * "entry", read `undefined` off it for `senderId` and `roomId`, compared
 * `undefined < now` (false, so not expired), pushed `undefined` onto the
 * allowlist — where it is serialised as `null` — deleted nothing, and reported
 * `paired undefined. They can now reach this session.` `deny('toString')` and
 * `removeRoom('valueOf')` each reported having removed something that was never
 * there.
 *
 * This package already writes the correct form nine files over, in
 * `command-routing.ts`, and for exactly this reason:
 *
 * ```js
 *   if (Object.prototype.hasOwnProperty.call(MATRIX_LOCAL, name)) …
 *   if (!Object.prototype.hasOwnProperty.call(MATRIX_ALLOWED, name)) …
 * ```
 *
 * — over two tables this file's authors wrote, against a `name` that comes from
 * a Matrix message. The tables here are read against a code the operator types
 * and a room id the MODEL supplies, and they had the other form.
 *
 * `Object.hasOwn` is the modern spelling and is available on the Node this runs
 * on; the `.call` form is kept so both halves of the package say it the same
 * way and a grep finds all of them.
 */
export function hasEntry(record: object | undefined, key: string): boolean {
  return record !== undefined && record !== null && Object.prototype.hasOwnProperty.call(record, key);
}

/** Read, mutate, write. The only supported way to change the file. */
export function updateAccess<T>(mutate: (access: Access) => T, file = ACCESS_FILE): T {
  const access = readAccess(file);
  const result = mutate(access);
  writeAccess(access, file);
  return result;
}

/** MXIDs contain `:` and `/`, neither of which is a safe filename anywhere. */
export function encodeSenderFilename(senderId: string): string {
  return encodeURIComponent(senderId);
}

/**
 * Tell the sidecar to send the "you're in" confirmation.
 *
 * A file drop rather than a call, because this is how the sidecar's
 * `checkApprovals()` poller already works — it watches `approved/` and needs
 * only the room to answer in. Reusing it means pairing works identically
 * whether it was approved from pi or by hand.
 */
export function markApproved(senderId: string, roomId: string, stateDir = STATE_DIR): void {
  const dir = join(stateDir, 'approved');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, encodeSenderFilename(senderId)), roomId, { mode: 0o600 });
}

export type PairOutcome =
  | { ok: true; senderId: string; roomId: string }
  | { ok: false; error: string };

/**
 * Approve a pending pairing by its code.
 *
 * The code is required and never inferred, even when exactly one pairing is
 * pending: anyone who can message the bot can create that one pending entry, so
 * "just approve the pending one" is precisely the shape a prompt-injected
 * request takes.
 */
export function pair(code: string, now = Date.now(), file = ACCESS_FILE): PairOutcome {
  return updateAccess((access) => {
    // AO6: `hasEntry`, not truthiness — `access.pending` came from JSON.parse
    // and answers for `constructor`, `toString` and six more.
    const entry = hasEntry(access.pending, code) ? access.pending[code] : undefined;
    if (!entry) {
      const codes = Object.keys(access.pending);
      return {
        ok: false as const,
        error: codes.length
          ? `no pending pairing with code "${code}". Pending: ${codes.join(', ')}`
          : `no pending pairing with code "${code}", and none are waiting.`,
      };
    }
    if (entry.expiresAt < now) {
      delete access.pending[code];
      return { ok: false as const, error: `pairing ${code} expired. Ask them to message again.` };
    }
    if (!access.allowFrom.includes(entry.senderId)) access.allowFrom.push(entry.senderId);
    delete access.pending[code];
    return { ok: true as const, senderId: entry.senderId, roomId: entry.roomId };
  }, file);
}

export function deny(code: string, file = ACCESS_FILE): boolean {
  return updateAccess((access) => {
    // AO6. `deny('toString')` used to answer "discarded pairing toString".
    if (!hasEntry(access.pending, code)) return false;
    delete access.pending[code];
    return true;
  }, file);
}

export function allow(mxid: string, file = ACCESS_FILE): { ok: boolean; error?: string } {
  if (!MXID_RE.test(mxid)) {
    return { ok: false, error: `"${mxid}" is not a full Matrix ID like @you:example.org` };
  }
  updateAccess((access) => {
    if (!access.allowFrom.includes(mxid)) access.allowFrom.push(mxid);
  }, file);
  return { ok: true };
}

export function remove(mxid: string, file = ACCESS_FILE): boolean {
  return updateAccess((access) => {
    const before = access.allowFrom.length;
    access.allowFrom = access.allowFrom.filter((id) => id !== mxid);
    return access.allowFrom.length !== before;
  }, file);
}

export function setPolicy(policy: string, file = ACCESS_FILE): { ok: boolean; error?: string } {
  if (!DM_POLICIES.includes(policy as DmPolicy)) {
    return { ok: false, error: `policy must be one of: ${DM_POLICIES.join(', ')}` };
  }
  updateAccess((access) => {
    access.dmPolicy = policy as DmPolicy;
  }, file);
  return { ok: true };
}

export function addRoom(
  roomId: string,
  options: { requireMention: boolean; allowFrom: string[] },
  file = ACCESS_FILE
): { ok: boolean; error?: string } {
  if (!ROOM_ID_RE.test(roomId)) {
    return {
      ok: false,
      error: `"${roomId}" is not a room ID. Room IDs start with ! — an #alias moves between rooms, the ID does not.`,
    };
  }
  updateAccess((access) => {
    access.rooms[roomId] = { requireMention: options.requireMention, allowFrom: options.allowFrom };
  }, file);
  return { ok: true };
}

export function removeRoom(roomId: string, file = ACCESS_FILE): boolean {
  return updateAccess((access) => {
    // AO6, and here the key can also be a room policy that is legitimately
    // falsy-shaped; `hasEntry` asks about presence rather than about value.
    if (!hasEntry(access.rooms, roomId)) return false;
    delete access.rooms[roomId];
    return true;
  }, file);
}

/** Channel-side presentation keys, as understood by the sidecar. */
export function setChannelKey(
  key: string,
  value: string,
  file = ACCESS_FILE
): { ok: boolean; error?: string } {
  const bad = (expected: string) => ({
    ok: false as const,
    error: `${key} expects ${expected} (got "${value}")`,
  });
  const asBool = (): boolean | undefined => {
    if (['true', '1', 'on', 'yes'].includes(value)) return true;
    if (['false', '0', 'off', 'no'].includes(value)) return false;
    return undefined;
  };

  switch (key) {
    case 'ackReaction':
      // Any emoji: Matrix has no whitelist. An empty string disables it.
      updateAccess((access) => {
        access.ackReaction = value;
      }, file);
      return { ok: true };
    case 'replyToMode': {
      if (!['off', 'first', 'all'].includes(value)) return bad('off | first | all');
      updateAccess((access) => {
        access.replyToMode = value as Access['replyToMode'];
      }, file);
      return { ok: true };
    }
    case 'textChunkLimit': {
      const limit = Number.parseInt(value, 10);
      if (!Number.isFinite(limit) || limit <= 0) return bad('a positive number of characters');
      updateAccess((access) => {
        access.textChunkLimit = limit;
      }, file);
      return { ok: true };
    }
    case 'format': {
      if (!['markdown', 'text'].includes(value)) return bad('markdown | text');
      updateAccess((access) => {
        access.format = value as Access['format'];
      }, file);
      return { ok: true };
    }
    case 'notice':
    case 'autoJoinUnknown': {
      const parsed = asBool();
      if (parsed === undefined) return bad('true | false');
      updateAccess((access) => {
        access[key] = parsed;
      }, file);
      return { ok: true };
    }
    case 'mentionPatterns': {
      let patterns: unknown;
      try {
        patterns = JSON.parse(value);
      } catch {
        return bad('a JSON array of regex strings, e.g. ["^hey pi\\\\b"]');
      }
      if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) {
        return bad('a JSON array of regex strings');
      }
      // Compiled here rather than at match time: an invalid regex would
      // otherwise throw inside the sidecar on every inbound message in a shared
      // room, which looks like the bot ignoring the room.
      for (const pattern of patterns as string[]) {
        try {
          new RegExp(pattern, 'i');
        } catch (err) {
          return { ok: false, error: `"${pattern}" is not a valid regex: ${err}` };
        }
      }
      updateAccess((access) => {
        access.mentionPatterns = patterns as string[];
      }, file);
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown channel setting "${key}"` };
  }
}

export const CHANNEL_SETTING_KEYS = [
  'ackReaction',
  'replyToMode',
  'textChunkLimit',
  'format',
  'notice',
  'autoJoinUnknown',
  'mentionPatterns',
];
