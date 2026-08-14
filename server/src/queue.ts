/**
 * A durable outbox for inbound messages.
 *
 * The channel server only exists while a pi session does. Close the
 * session and the bot is not merely idle — it is gone, and anything sent to it
 * meanwhile would be lost. Matrix holds those messages server-side, but a bot
 * ignores everything older than its own startup precisely so a restart does
 * not re-answer old conversations. Without something tracking what has
 * actually been *delivered*, "sent while you were away" and "already handled"
 * are indistinguishable.
 *
 * So every inbound message is written here before it is handed to the session,
 * and removed only once it has been. That ordering is what makes it durable:
 * a crash between receiving and delivering leaves the message queued rather
 * than lost, and the watermark stops an already-delivered message coming back
 * on the next start.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { STATE_DIR, log } from './state.js';

const QUEUE_FILE = join(STATE_DIR, 'queue.json');
const WATERMARK_FILE = join(STATE_DIR, 'watermark.json');

/** Keep the backlog to something a session can actually read on return. */
export const MAX_QUEUED = 50;
/** Older than this and the conversation has moved on without us. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type QueuedMessage = {
  /** The Matrix event ID. Doubles as the dedupe key. */
  id: string;
  /** Event timestamp, milliseconds. Ordering and ageing key. */
  ts: number;
  content: string;
  meta: Record<string, string>;
};

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`${path} unreadable, starting fresh: ${err}`);
    }
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // Atomic: a reader never sees a half-written queue, and a crash mid-write
  // leaves the previous state intact rather than a truncated file.
  renameSync(tmp, path);
}

export function readQueue(): QueuedMessage[] {
  const queue = readJson<QueuedMessage[]>(QUEUE_FILE, []);
  return Array.isArray(queue) ? queue : [];
}

function writeQueue(queue: QueuedMessage[]): void {
  writeJson(QUEUE_FILE, queue);
}

/**
 * The timestamp of the newest message already delivered to a session.
 *
 * Everything at or below this has been seen; the catch-up on the next start
 * begins just above it.
 */
export function readWatermark(): number {
  const value = readJson<{ ts?: number }>(WATERMARK_FILE, {});
  return typeof value.ts === 'number' ? value.ts : 0;
}

export function writeWatermark(ts: number): void {
  if (ts <= readWatermark()) return;
  writeJson(WATERMARK_FILE, { ts });
}

/**
 * Add a message, unless it is already queued or already delivered.
 *
 * Returns false when the message was a duplicate — worth knowing, because the
 * catch-up on startup re-offers everything the initial sync returns and most
 * of it will have been handled already.
 */
export function enqueue(message: QueuedMessage, now = Date.now()): boolean {
  const queue = readQueue();
  if (queue.some((entry) => entry.id === message.id)) return false;
  if (message.ts <= readWatermark()) return false;

  queue.push(message);
  queue.sort((a, b) => a.ts - b.ts);

  const fresh = queue.filter((entry) => now - entry.ts <= MAX_AGE_MS);
  const dropped = queue.length - fresh.length;
  // Keep the newest: on return you want the end of the conversation, not its
  // beginning. Say what was dropped rather than silently truncating.
  const bounded = fresh.slice(-MAX_QUEUED);
  const trimmed = fresh.length - bounded.length;
  if (dropped > 0) log(`dropped ${dropped} queued message(s) older than 7 days`);
  if (trimmed > 0) log(`dropped ${trimmed} queued message(s) over the ${MAX_QUEUED} cap`);

  writeQueue(bounded);
  return bounded.some((entry) => entry.id === message.id);
}

/** Remove a delivered message and advance the watermark past it. */
export function markDelivered(id: string): void {
  const queue = readQueue();
  const delivered = queue.find((entry) => entry.id === id);
  writeQueue(queue.filter((entry) => entry.id !== id));
  if (delivered) writeWatermark(delivered.ts);
}

/**
 * Hand every queued message to `deliver`, oldest first, stopping at the first
 * failure.
 *
 * Stopping matters: delivering out of order would reorder someone's
 * conversation, and continuing past a failure would advance the watermark over
 * a message that never arrived.
 */
export async function flush(
  deliver: (message: QueuedMessage, index: number, total: number) => Promise<void>
): Promise<{ delivered: number; remaining: number }> {
  const queue = readQueue();
  let delivered = 0;
  for (const [index, message] of queue.entries()) {
    try {
      await deliver(message, index, queue.length);
    } catch (err) {
      log(`delivery stopped at queued message ${message.id}: ${err}`);
      break;
    }
    markDelivered(message.id);
    delivered += 1;
  }
  return { delivered, remaining: readQueue().length };
}

/** Path helpers, so tests and the docs agree on where this lives. */
export const QUEUE_PATH = QUEUE_FILE;
export const WATERMARK_PATH = WATERMARK_FILE;
