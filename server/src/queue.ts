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
 * How far back a message that is genuinely NEW can be stamped — AO4.
 *
 * `origin_server_ts` is set by the sender's homeserver, not by ours. Two
 * homeservers are two clocks, federation delivers out of order, and a message
 * can therefore arrive now carrying a timestamp from before the newest one we
 * have already answered. Five minutes is the ordinary sanity bound for that skew
 * and is comfortably more than anything seen on one server.
 *
 * Below this horizon a message is old news, and the ageing rule the queue
 * already has (`MAX_AGE_MS`) is the one that applies. Above it, the question is
 * decided by IDENTITY rather than by time — see {@link Watermark}.
 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * How many delivered event IDs are remembered above the horizon. Bounded
 * because the file is rewritten on every delivery; two hundred is far more than
 * five minutes of one conversation and costs a few kilobytes.
 */
export const MAX_REMEMBERED_IDS = 200;

/**
 * What has already been handed to a session.
 *
 * ## The identity this used to be
 *
 * It was one number, and its docstring said *"Everything at or below this has
 * been seen"*. That is a claim about IDENTITY made out of a claim about TIME,
 * and the two come apart in three ordinary ways:
 *
 * ```
 *   two events in the same millisecond      `ts <= watermark` drops the second
 *   two rooms, two homeservers, two clocks  a live message stamped below ours
 *   federation delivering out of order      the same, without any clock being wrong
 * ```
 *
 * `enqueue` returns false in all three, and `handleInbound` reads false as
 * *"Already delivered on an earlier run"* and returns — after the message has
 * already been acknowledged with a reaction. From the sender's side the bot
 * reacted and then never answered, which is the exact failure the outbox exists
 * to prevent, reached through the outbox.
 *
 * ## What it is now
 *
 * The timestamp still bounds the catch-up — that is the job it was written for,
 * and re-offering a week of history is not something a session should have to
 * re-answer. But inside the last {@link CLOCK_SKEW_MS} the question is asked of
 * the EVENT ID, which is what Matrix guarantees unique and what the queue's own
 * de-duplication has always used one line above.
 *
 * A file written before this pass is `{ ts }` with no ids; it reads as a
 * watermark with an empty id set, which is exactly the old behaviour for
 * everything below the horizon and the new behaviour for everything above it.
 */
export type Watermark = {
  /** The newest `origin_server_ts` already delivered. */
  ts: number;
  /** Event IDs delivered at or above `ts - CLOCK_SKEW_MS`. */
  ids: string[];
};

export function readWatermark(): Watermark {
  const value = readJson<{ ts?: number; ids?: unknown }>(WATERMARK_FILE, {});
  const ts = typeof value.ts === 'number' && Number.isFinite(value.ts) ? value.ts : 0;
  const ids = Array.isArray(value.ids) ? value.ids.filter((id): id is string => typeof id === 'string') : [];
  return { ts, ids };
}

/**
 * Record that `id` (stamped `ts`) has been delivered.
 *
 * The timestamp only ever moves forward; the id set is pruned to the horizon
 * around whichever timestamp is newer, so a late-but-fresh message is
 * remembered even though it did not advance the mark.
 */
export function writeWatermark(ts: number, id?: string): void {
  const current = readWatermark();
  const nextTs = Math.max(current.ts, typeof ts === 'number' && Number.isFinite(ts) ? ts : 0);
  const ids = id ? [...current.ids.filter((seen) => seen !== id), id] : [...current.ids];
  const bounded = ids.slice(-MAX_REMEMBERED_IDS);
  if (nextTs === current.ts && bounded.length === current.ids.length && bounded.every((v, i) => v === current.ids[i])) {
    return;
  }
  writeJson(WATERMARK_FILE, { ts: nextTs, ids: bounded });
}

/**
 * Has this message already been handed to a session?
 *
 * Identity above the horizon, time below it. Exported so the rule can be driven
 * without a state directory — it is the whole of AO4.
 */
export function alreadyDelivered(message: Pick<QueuedMessage, 'id' | 'ts'>, watermark: Watermark): boolean {
  if (watermark.ids.includes(message.id)) return true;
  return message.ts < watermark.ts - CLOCK_SKEW_MS;
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
  // AO4: by identity above the clock-skew horizon, by time below it. This used
  // to be `message.ts <= readWatermark()`, which reads "stamped no later than
  // something I answered" as "the thing I answered".
  if (alreadyDelivered(message, readWatermark())) return false;

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

/** Remove a delivered message and record it — by id as well as by timestamp. */
export function markDelivered(id: string): void {
  const queue = readQueue();
  const delivered = queue.find((entry) => entry.id === id);
  writeQueue(queue.filter((entry) => entry.id !== id));
  if (delivered) writeWatermark(delivered.ts, delivered.id);
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
