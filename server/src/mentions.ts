/**
 * Does this message address the bot?
 *
 * Only relevant in shared rooms, where `requireMention` is on by default —
 * a bot that answers every line in a busy room is a bot that gets kicked.
 *
 * Matrix gives four different signals for the same intent, and clients disagree
 * about which they emit, so all four are checked. Kept free of Matrix types so
 * the precedence is testable directly.
 */

export type MentionSignals = {
  /** Plain-text body of the message. */
  text: string;
  /** `formatted_body`, when the client sent one. */
  html?: string | undefined;
  /** `m.mentions.user_ids` — the intentional-mentions spec. */
  mentionedUserIds?: string[] | undefined;
  /** Sender of the event this one replies to, when it could be resolved. */
  replyToSender?: string | undefined;
};

export type MentionConfig = {
  botUserId: string;
  /** The bot's current display name in this room, when known. */
  botDisplayName?: string | undefined;
  /** Extra case-insensitive regexes that count as a mention. */
  patterns?: string[] | undefined;
};

/** `@claude:example.org` → `claude`. */
export function localpart(userId: string): string {
  const match = /^@([^:]+):/.exec(userId);
  return match ? match[1]! : userId;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A bare word match, so "claudette" does not read as "claude".
 *
 * `\b` is no good here: display names routinely contain punctuation and
 * emoji, where word boundaries land in surprising places.
 */
function mentionsWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapeRegExp(needle)}([^\\p{L}\\p{N}_]|$)`, 'iu');
  return pattern.test(haystack);
}

export function isMentioned(signals: MentionSignals, config: MentionConfig): boolean {
  const { botUserId } = config;

  // 1. The intentional-mentions field. Authoritative when present.
  if (signals.mentionedUserIds?.includes(botUserId)) return true;

  // 2. A reply to one of the bot's own messages is an implicit mention — it is
  //    how people answer a question the bot asked.
  if (signals.replyToSender && signals.replyToSender === botUserId) return true;

  // 3. A pill in formatted_body is an <a href="https://matrix.to/#/@bot:hs">.
  //    Clients that predate m.mentions still send only this.
  if (signals.html && signals.html.includes(`matrix.to/#/${botUserId}`)) return true;

  const text = signals.text ?? '';
  if (text.includes(botUserId)) return true;
  if (mentionsWord(text, localpart(botUserId))) return true;
  if (config.botDisplayName && mentionsWord(text, config.botDisplayName)) return true;

  // 4. Whatever else the user decided counts, e.g. "^hey claude\b".
  for (const pattern of config.patterns ?? []) {
    try {
      if (new RegExp(pattern, 'i').test(text)) return true;
    } catch {
      // A user-supplied regex that does not compile is skipped, not fatal.
    }
  }

  return false;
}
