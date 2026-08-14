/**
 * Files that arrive from Matrix, and files that go back out.
 *
 * Inbound attachments are written to `<state-dir>/inbox/` so the assistant can
 * `Read` them by path. Outbound paths are checked against the state directory
 * first — see `assertSendable`.
 */

import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, sep } from 'node:path';

import { INBOX_DIR, STATE_DIR } from './state.js';

/**
 * One cap for both directions.
 *
 * 50MB is what most homeservers allow by default. @prinny/bot's own download
 * default is lower, so it is passed explicitly on the way in — otherwise a file
 * the bot happily sends could not be read back, which is a confusing asymmetry
 * to debug.
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Extensions Matrix clients render inline as images. */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.oga', '.opus', '.wav', '.flac', '.m4a']);

export type OutboundKind = 'image' | 'video' | 'audio' | 'file';

export function kindForPath(path: string): OutboundKind {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'file';
}

/**
 * Refuse to send the channel's own state.
 *
 * `reply`'s `files` parameter takes any path, and Claude can already read and
 * paste a file's contents, so this is not a new exfiltration channel for
 * arbitrary paths. The bot's credentials, crypto store and allowlist are the
 * one thing it has no reason to ever hand out — and a message asking it to is
 * precisely the shape a prompt injection takes.
 */
export function assertSendable(path: string): void {
  let real: string;
  let stateReal: string;
  try {
    real = realpathSync(path);
    stateReal = realpathSync(STATE_DIR);
  } catch {
    // Either the file does not exist — statSync reports that properly — or the
    // state dir does not, in which case there is nothing to protect.
    return;
  }
  const inbox = join(stateReal, 'inbox');
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${path}`);
  }
}

export function assertWithinSizeLimit(path: string): void {
  const stat = statSync(path);
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `file too large: ${path} (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ` +
        `${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)`
    );
  }
}

/**
 * Strip anything that could break out of the `<channel>` notification tag or
 * escape the inbox directory. Filenames are sender-controlled.
 */
export function sanitizeName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return name.replace(/[<>[\]\r\n;/\\]/g, '_').slice(0, 120) || undefined;
}

/** Write an inbound attachment to the inbox and return its path. */
export function writeToInbox(data: Buffer, filename: string, eventId: string): string {
  mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });
  const safe = sanitizeName(filename) ?? 'attachment';
  // The event id makes this stable, so downloading the same message twice does
  // not litter the inbox with copies.
  const stem = eventId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'evt';
  const path = join(INBOX_DIR, `${stem}-${safe}`);
  writeFileSync(path, data);
  return path;
}
