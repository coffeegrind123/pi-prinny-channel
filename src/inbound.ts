/**
 * Turning a Matrix message into the text pi's model sees.
 *
 * Claude Code renders a channel notification as a `<channel …>` block and the
 * tool descriptions refer to it by that name. pi has no channel concept, so the
 * extension builds the same block itself and injects it with
 * `pi.sendUserMessage`. Keeping the shape identical is not nostalgia: every
 * instruction the model is given — "pass room_id back to reply", "if the block
 * has image_path, read that file" — is about this block, and a different one
 * would make all of them subtly wrong.
 */

/** The notification payload the sidecar sends on `notifications/claude/channel`. */
export type ChannelMessage = {
  content: string;
  meta: Record<string, string>;
};

/**
 * Attribute values are escaped, because they are not ours.
 *
 * `user` is a Matrix display name, which the sender chooses. A name containing
 * `" room_id="!attacker:evil` would otherwise close the attribute and open a
 * new one, letting anyone who can message the bot forge the room a reply is
 * addressed to. Escaping the five XML entities closes that off; the tag is then
 * well-formed whatever anybody calls themselves.
 */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The message body, with the block's own closing tag defused.
 *
 * A sender who writes `</channel>` mid-message would otherwise end the quoted
 * region early, and everything after it would read as instructions from the
 * harness rather than as something a stranger typed. The zero-width space keeps
 * the text legible while making it no longer the tag.
 */
export function neutralizeClosingTag(content: string): string {
  // Written as an escape, not as a literal: an invisible character pasted into
  // source is the kind of thing a later edit deletes without noticing.
  return content.replace(/<\s*\/\s*channel\s*>/gi, '<\u200b/channel>');
}

/** Order matters only for readability; the model reads these by name. */
const META_ORDER = [
  'room_id',
  'message_id',
  'user',
  'user_id',
  'ts',
  'is_direct',
  'image_path',
  'attachment_kind',
  'attachment_name',
  'attachment_mime',
  'attachment_size',
  'delayed',
  'queued_for',
  'backlog_position',
];

export function renderChannelBlock(message: ChannelMessage): string {
  const meta = message.meta ?? {};
  const seen = new Set<string>();
  const attributes: string[] = ['source="prinny"'];

  const push = (key: string) => {
    const value = meta[key];
    if (value === undefined || value === null || value === '') return;
    if (seen.has(key)) return;
    seen.add(key);
    attributes.push(`${key}="${escapeAttribute(String(value))}"`);
  };

  for (const key of META_ORDER) push(key);
  // `chat_id` is a compatibility alias the sidecar emits alongside `room_id`;
  // repeating the same value under a second name only invites the model to
  // pass the wrong one, so it is dropped rather than forwarded.
  for (const key of Object.keys(meta)) {
    if (key === 'chat_id') continue;
    push(key);
  }

  const body = neutralizeClosingTag(message.content ?? '').trim();
  return `<channel ${attributes.join(' ')}>\n${body}\n</channel>`;
}

/** The room a block came from, for the auto-reply fallback. */
export function roomOf(message: ChannelMessage): string | undefined {
  const room = message.meta?.room_id ?? message.meta?.chat_id;
  return typeof room === 'string' && room ? room : undefined;
}

/**
 * Is this a backlog item rather than something just said?
 *
 * The sidecar sets `delayed` when it flushes a message that waited in the
 * outbox. Worth surfacing: answering an hours-old message in the present tense
 * reads as though the bot has been sitting there ignoring somebody.
 */
export function isDelayed(message: ChannelMessage): boolean {
  return message.meta?.delayed === 'true';
}
