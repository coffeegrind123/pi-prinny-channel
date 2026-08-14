/**
 * Room history and search.
 *
 * Neither official channel plugin has both: Telegram's Bot API exposes no
 * history at all, and Discord gives history but no search. Matrix gives both,
 * with one sharp edge — **server-side search cannot see an encrypted room**,
 * because the homeserver holds only ciphertext. That case is reported as
 * exactly what it is rather than as an empty result set, which would read as
 * "nothing was ever said here".
 */

// Types only — see the note in server.ts. A value import here would drag
// matrix-js-sdk in at load time and blow the MCP handshake budget.
import type { MatrixClient, MatrixEvent, Room } from '@prinny/bot';

import { log } from './state.js';

export type HistoryEntry = {
  event_id: string;
  sender: string;
  ts: string;
  text: string;
  /** Present when the event carries an attachment. */
  attachment?: { kind: string; name?: string; mime?: string; size?: number };
  edited?: boolean;
};

const MAX_LIMIT = 200;

function bodyOf(event: MatrixEvent): string {
  const content = event.getContent() as Record<string, unknown>;
  const replacement = content['m.new_content'] as Record<string, unknown> | undefined;
  const source = replacement ?? content;
  const body = source.body;
  return typeof body === 'string' ? body : '';
}

function attachmentOf(event: MatrixEvent): HistoryEntry['attachment'] {
  const content = event.getContent() as Record<string, unknown>;
  const msgtype = typeof content.msgtype === 'string' ? content.msgtype : undefined;
  const isMedia =
    event.getType() === 'm.sticker' ||
    (msgtype !== undefined && ['m.image', 'm.file', 'm.audio', 'm.video'].includes(msgtype));
  if (!isMedia) return undefined;

  const info = (content.info ?? {}) as Record<string, unknown>;
  return {
    kind: event.getType() === 'm.sticker' ? 'sticker' : (msgtype ?? 'm.file').replace(/^m\./, ''),
    ...(typeof content.body === 'string' ? { name: content.body } : {}),
    ...(typeof info.mimetype === 'string' ? { mime: info.mimetype } : {}),
    ...(typeof info.size === 'number' ? { size: info.size } : {}),
  };
}

function toEntry(event: MatrixEvent): HistoryEntry | null {
  const type = event.getType();
  if (type !== 'm.room.message' && type !== 'm.sticker') return null;
  if (event.isRedacted()) return null;

  const relation = (event.getContent() as Record<string, unknown>)['m.relates_to'] as
    | { rel_type?: string }
    | undefined;
  // An edit is not a separate message. The replaced original is what the
  // timeline shows, and matrix-js-sdk has already applied it there.
  if (relation?.rel_type === 'm.replace') return null;

  const text = bodyOf(event);
  const attachment = attachmentOf(event);
  if (!text && !attachment) return null;

  return {
    event_id: event.getId() ?? '',
    sender: event.getSender() ?? '',
    ts: new Date(event.getTs()).toISOString(),
    text,
    ...(attachment ? { attachment } : {}),
    ...(event.replacingEventId() ? { edited: true } : {}),
  };
}

/**
 * Pull the most recent `limit` messages from a room, oldest first.
 *
 * Backfills through `/messages` when the live timeline is short — a session
 * that just started has synced only the last handful of events, and "fetch the
 * last 50" must not silently return 10.
 */
export async function fetchMessages(
  client: MatrixClient,
  roomId: string,
  limit: number
): Promise<HistoryEntry[]> {
  const room: Room | null = client.getRoom(roomId);
  if (!room) throw new Error(`not in room ${roomId} — the bot must be joined to read its history`);

  const want = Math.max(1, Math.min(limit, MAX_LIMIT));
  const timeline = room.getLiveTimeline();

  // Paginate until we have enough candidates or the room runs out. The cap on
  // rounds is what stops an empty room from spinning: each round that returns
  // nothing new means we are at the start of what we can see.
  for (let round = 0; round < 10; round += 1) {
    const events = timeline.getEvents();
    if (events.filter((e) => toEntry(e) !== null).length >= want) break;
    const before = events.length;
    try {
      await client.scrollback(room, Math.max(want, 30));
    } catch (err) {
      log(`scrollback in ${roomId} failed: ${err}`);
      break;
    }
    if (timeline.getEvents().length === before) break;
  }

  const events = timeline.getEvents();

  // Late-arriving room keys mean some of these can still be ciphertext.
  await Promise.all(
    events
      .filter((event) => event.isEncrypted() && event.getType() === 'm.room.encrypted')
      .map((event) => client.decryptEventIfNeeded(event).catch(() => undefined))
  );

  const entries: HistoryEntry[] = [];
  for (const event of events) {
    const entry = toEntry(event);
    if (entry) entries.push(entry);
  }
  return entries.slice(-want);
}

export type SearchOutcome =
  | { ok: true; results: HistoryEntry[]; count: number }
  | { ok: false; reason: string };

/**
 * Server-side search, scoped to one room.
 *
 * Returns a stated reason rather than an empty list when the room is
 * encrypted. The distinction matters: "no matches" and "this cannot be
 * searched" lead to completely different next steps, and collapsing them is
 * how an assistant ends up telling someone their message does not exist.
 */
export async function searchMessages(
  client: MatrixClient,
  roomId: string,
  term: string,
  limit: number
): Promise<SearchOutcome> {
  const room = client.getRoom(roomId);
  if (!room) throw new Error(`not in room ${roomId} — the bot must be joined to search it`);

  // By the time anyone can call this, the Matrix layer is loaded and cached, so
  // the dynamic import is a map lookup.
  const { roomIsEncrypted } = await import('@prinny/bot');
  if (roomIsEncrypted(client, roomId)) {
    return {
      ok: false,
      reason:
        'this room is end-to-end encrypted, so the homeserver only holds ciphertext and cannot ' +
        'search it. Use fetch_messages to pull history and search it yourself.',
    };
  }

  const want = Math.max(1, Math.min(limit, MAX_LIMIT));
  const response = await client.search({
    body: {
      search_categories: {
        room_events: {
          search_term: term,
          keys: ['content.body'],
          filter: { rooms: [roomId], limit: want },
          order_by: 'recent' as never,
        },
      },
    },
  });

  const roomEvents = response.search_categories?.room_events;
  const results = (roomEvents?.results ?? []).flatMap((hit) => {
    const raw = hit.result;
    if (!raw) return [];
    const content = (raw.content ?? {}) as Record<string, unknown>;
    const body = typeof content.body === 'string' ? content.body : '';
    if (!body) return [];
    return [
      {
        event_id: raw.event_id,
        sender: raw.sender,
        ts: new Date(raw.origin_server_ts).toISOString(),
        text: body,
      } satisfies HistoryEntry,
    ];
  });

  return { ok: true, results, count: roomEvents?.count ?? results.length };
}

/** Render history as one compact line per message. */
export function renderHistory(entries: HistoryEntry[]): string {
  if (entries.length === 0) return '(no messages)';
  return entries
    .map((entry) => {
      const attachment = entry.attachment
        ? ` [${entry.attachment.kind}${entry.attachment.name ? `: ${entry.attachment.name}` : ''}]`
        : '';
      const edited = entry.edited ? ' (edited)' : '';
      return `${entry.ts} ${entry.sender} ${entry.event_id}${edited}: ${entry.text}${attachment}`;
    })
    .join('\n');
}
