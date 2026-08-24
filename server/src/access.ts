/**
 * Who reaches the session, and who is silently dropped.
 *
 * A Matrix bot is publicly addressable: anyone who learns its MXID can invite
 * it to a room and start talking. Without this gate those messages would flow
 * straight into a pi session with the user's filesystem and shell
 * behind it.
 *
 * State lives in `<state-dir>/access.json` and is re-read on every inbound
 * message, so `/prinny` takes effect without a restart. Nothing here
 * touches Matrix — it is pure policy over plain data, which is also what makes
 * it testable.
 */

import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { withFileLock } from './file-lock.js';
import { join } from 'node:path';

import { ACCESS_FILE, APPROVED_DIR, STATE_DIR, log } from './state.js';

export type PendingEntry = {
  senderId: string;
  roomId: string;
  createdAt: number;
  expiresAt: number;
  replies: number;
};

export type RoomPolicy = {
  /** Respond only when mentioned or replied to. */
  requireMention: boolean;
  /** Restrict triggers to these MXIDs. Empty means any member. */
  allowFrom: string[];
};

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled';
  /** MXIDs allowed to talk to the bot directly. */
  allowFrom: string[];
  /** Shared rooms the bot is active in. Empty means direct-message only. */
  rooms: Record<string, RoomPolicy>;
  pending: Record<string, PendingEntry>;
  /** Case-insensitive regexes that count as a mention in a shared room. */
  mentionPatterns?: string[];

  // ── Delivery and presentation ──────────────────────────────────────────────
  /** Emoji to react with on receipt. Empty string disables. */
  ackReaction?: string;
  /** Reply-relation on chunked replies. Default 'first'. */
  replyToMode?: 'off' | 'first' | 'all';
  /** Chunk ceiling in characters. Matrix's own limit applies regardless. */
  textChunkLimit?: number;
  /** How outbound text is rendered. Default 'markdown'. */
  format?: 'markdown' | 'text';
  /** Send bot output as `m.notice`, the Matrix convention for automation. */
  notice?: boolean;
  /** Auto-accept invites from senders the gate would drop. Default false. */
  autoJoinUnknown?: boolean;
};

export const PENDING_TTL_MS = 60 * 60 * 1000;
export const MAX_PENDING = 3;
export const MAX_PAIRING_REPLIES = 2;

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], rooms: {}, pending: {} };
}

const STATIC = process.env.PRINNY_ACCESS_MODE === 'static';

export function readAccessFile(): Access {
  let raw: string;
  try {
    raw = readFileSync(ACCESS_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess();
    throw err;
  }

  let parsed: Partial<Access>;
  try {
    parsed = JSON.parse(raw) as Partial<Access>;
  } catch {
    // Quarantine rather than delete: it may be a hand-edit the user wants back,
    // and starting from defaults beats refusing to run.
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`);
    } catch {
      // Read-only state dir; the defaults below still apply for this run.
    }
    log('access.json is corrupt, moved aside. Starting fresh.');
    return defaultAccess();
  }

  return {
    dmPolicy: parsed.dmPolicy ?? 'pairing',
    allowFrom: parsed.allowFrom ?? [],
    rooms: parsed.rooms ?? {},
    pending: parsed.pending ?? {},
    mentionPatterns: parsed.mentionPatterns,
    ackReaction: parsed.ackReaction,
    replyToMode: parsed.replyToMode,
    textChunkLimit: parsed.textChunkLimit,
    format: parsed.format,
    notice: parsed.notice,
    autoJoinUnknown: parsed.autoJoinUnknown,
  };
}

/**
 * In static mode access is snapshotted at boot, never re-read and never
 * written. Pairing needs runtime writes, so it is downgraded rather than left
 * to hand out codes that can never be approved.
 */
const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const access = readAccessFile();
      if (access.dmPolicy === 'pairing') {
        log('static mode — dmPolicy "pairing" downgraded to "allowlist"');
        access.dmPolicy = 'allowlist';
      }
      access.pending = {};
      return access;
    })()
  : null;

export function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile();
}

export function saveAccess(access: Access): void {
  if (STATIC) return;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  // UNIQUE PER PROCESS. This was `${ACCESS_FILE}.tmp`, and the extension's
  // `writeAccess` used the same string. `writeFileSync` opens O_TRUNC, so two
  // processes sharing one temp path splice: one truncates mid-write of the
  // other, the other's remaining bytes land past the new end, and the atomic
  // rename below faithfully installs the mixture. `readAccessFile` then
  // quarantines it and every allowlist entry is gone.
  const tmp = `${ACCESS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
  // Rename is atomic, so /prinny never reads a half-written file.
  renameSync(tmp, ACCESS_FILE);
}

export function pruneExpired(access: Access, now = Date.now()): boolean {
  let changed = false;
  for (const [code, entry] of Object.entries(access.pending)) {
    if (entry.expiresAt < now) {
      delete access.pending[code];
      changed = true;
    }
  }
  return changed;
}

/** What the gate knows about an inbound message. No Matrix types on purpose. */
export type Inbound = {
  senderId: string;
  roomId: string;
  /** A two-person room the bot treats as a direct message. */
  isDirect: boolean;
  /** Whether the message names the bot, by mention, reply, or pattern. */
  mentionsBot: boolean;
};

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop'; reason: string }
  | { action: 'pair'; code: string; isResend: boolean };

/**
 * Decide what happens to one inbound message.
 *
 * `newCode` is injectable so tests are not at the mercy of randomness; the
 * default is what actually runs.
 */
export function gate(
  inbound: Inbound,
  options: { now?: number; newCode?: () => string } = {}
): GateResult {
  const now = options.now ?? Date.now();
  const newCode = options.newCode ?? (() => randomBytes(3).toString('hex'));

  // UNDER THE FILE'S LOCK, read to write, because that is the whole span that
  // has to be indivisible. Every `saveAccess` below writes back the snapshot
  // `loadAccess` took at the top; without the lock the extension can read,
  // approve a pairing and write in between, and this function's next write
  // silently reinstates the pre-approval document. The body is a few hundred
  // microseconds of JSON, so holding a lock across it costs nothing.
  return withFileLock(ACCESS_FILE, () => gateLocked(inbound, now, newCode), { onWarn: log });
}

function gateLocked(inbound: Inbound, now: number, newCode: () => string): GateResult {
  const access = loadAccess();
  if (pruneExpired(access, now)) saveAccess(access);

  if (access.dmPolicy === 'disabled') return { action: 'drop', reason: 'channel disabled' };

  const { senderId, roomId, isDirect } = inbound;

  if (isDirect) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access };
    if (access.dmPolicy === 'allowlist') return { action: 'drop', reason: 'not allowlisted' };

    // `Object.entries` is own-keys-only, so this loop was always correct — it is
    // the CONTROL for AO6, and the reason the sidecar's own pairing path never
    // showed the symptom the extension's `pair()` did.
    for (const [code, entry] of Object.entries(access.pending)) {
      if (entry.senderId !== senderId) continue;
      // Two replies maximum — the first, and one reminder. After that a
      // stranger poking the bot gets nothing back, so it cannot be used as an
      // amplifier or as a presence oracle.
      if ((entry.replies ?? 1) >= MAX_PAIRING_REPLIES) {
        return { action: 'drop', reason: 'pairing already announced' };
      }
      entry.replies = (entry.replies ?? 1) + 1;
      saveAccess(access);
      return { action: 'pair', code, isResend: true };
    }

    if (Object.keys(access.pending).length >= MAX_PENDING) {
      return { action: 'drop', reason: 'too many pending pairings' };
    }

    const code = newCode();
    access.pending[code] = {
      senderId,
      roomId,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      replies: 1,
    };
    saveAccess(access);
    return { action: 'pair', code, isResend: false };
  }

  // AO6: presence, not truthiness — the same question `assertAllowedRoom` asks
  // above, so the inbound gate and the outbound gate cannot disagree about
  // which rooms exist.
  const policy = Object.prototype.hasOwnProperty.call(access.rooms, roomId)
    ? access.rooms[roomId]
    : undefined;
  if (!policy) return { action: 'drop', reason: 'room not enabled' };

  const roomAllowFrom = policy.allowFrom ?? [];
  if (roomAllowFrom.length > 0 && !roomAllowFrom.includes(senderId)) {
    return { action: 'drop', reason: 'sender not allowed in this room' };
  }
  if ((policy.requireMention ?? true) && !inbound.mentionsBot) {
    return { action: 'drop', reason: 'not addressed to the bot' };
  }
  return { action: 'deliver', access };
}

/**
 * Allow/drop for the bot's own commands: same rules, no pairing side effects.
 *
 * `/status` must work for someone mid-pairing — that is how they re-read the
 * code they lost — so a pending sender is told apart from a refused one.
 */
export function commandGate(
  inbound: Pick<Inbound, 'senderId' | 'isDirect'>
): { access: Access; senderId: string } | null {
  if (!inbound.isDirect) return null;
  // Same reason as `gate()`: this one prunes and writes too.
  return withFileLock(
    ACCESS_FILE,
    () => {
      const access = loadAccess();
      if (pruneExpired(access)) saveAccess(access);
      if (access.dmPolicy === 'disabled') return null;
      if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(inbound.senderId)) {
        return null;
      }
      return { access, senderId: inbound.senderId };
    },
    { onWarn: log }
  );
}

/**
 * Outbound gate: reply/react/edit may only target a room the inbound gate
 * would have delivered from.
 *
 * Without this, a prompt injection landing in the session could name any room
 * on the homeserver and have the bot post there.
 */
export function assertAllowedRoom(roomId: string, directRoomIds: ReadonlySet<string>): void {
  const access = loadAccess();
  // AO6, twenty-fourth pass. `roomId in access.rooms` walks the PROTOTYPE
  // chain, and `access.rooms` comes out of `JSON.parse`, so this returned —
  // i.e. ALLOWED — for `constructor`, `toString`, `valueOf`, `__proto__`,
  // `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable` and
  // `toLocaleString`. `roomId` here is whatever the model passed to the tool,
  // which is precisely the actor this function's own docstring names: "a prompt
  // injection landing in the session could name any room on the homeserver and
  // have the bot post there".
  //
  // Nothing was ever posted through it — those eight are not room IDs and the
  // homeserver rejects them — so this is a gate that answered a question it was
  // never asked rather than a leak. It is still the wrong answer, it is one
  // operator away from the right one, and `src/command-routing.ts` in the same
  // package already writes the right one over two tables of its own.
  if (Object.prototype.hasOwnProperty.call(access.rooms, roomId)) return;
  if (directRoomIds.has(roomId)) return;
  throw new Error(
    `room ${roomId} is not allowlisted — enable it with /prinny room add ${roomId}`
  );
}

/**
 * `/prinny pair` drops a file at `approved/<encoded-mxid>` holding the
 * room ID. Poll for it, confirm in that room, clean up.
 *
 * A file rather than a signal because the skill is a separate process editing
 * JSON, and this is the one thing it needs to reach back with.
 */
export function checkApprovals(send: (roomId: string, text: string) => Promise<unknown>): void {
  let files: string[];
  try {
    files = readdirSync(APPROVED_DIR);
  } catch {
    return;
  }

  for (const name of files) {
    const file = join(APPROVED_DIR, name);
    let roomId: string;
    try {
      roomId = readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    if (!roomId) {
      rmSync(file, { force: true });
      continue;
    }
    void send(roomId, 'Paired. Say hi to pi.').then(
      () => rmSync(file, { force: true }),
      (err) => {
        log(`failed to confirm approval in ${roomId}: ${err}`);
        // Remove regardless — retrying a broken send forever is worse than
        // one missed confirmation the user can see for themselves.
        rmSync(file, { force: true });
      }
    );
  }
}

/** MXIDs contain `:` and `/`, neither of which is a safe filename anywhere. */
export function encodeSenderFilename(senderId: string): string {
  return encodeURIComponent(senderId);
}
