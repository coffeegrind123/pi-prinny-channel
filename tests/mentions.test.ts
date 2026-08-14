import { describe, expect, it, loadServerModule, RUNTIME_DIST } from './harness.ts';

const { isMentioned, localpart } = await loadServerModule<{
  isMentioned: (message: Record<string, unknown>, bot: Record<string, unknown>) => boolean;
  localpart: (mxid: string) => string;
}>('mentions');

const BOT = { botUserId: '@claude:example.org', botDisplayName: 'Claude' };

describe('localpart', () => {
  it('extracts the localpart of an MXID', () => {
    expect(localpart('@claude:example.org')).toBe('claude');
  });

  it('returns the input unchanged when it is not an MXID', () => {
    expect(localpart('claude')).toBe('claude');
  });
});

describe('isMentioned', () => {
  it('honours m.mentions, the intentional-mentions field', () => {
    expect(
      isMentioned({ text: 'nothing here', mentionedUserIds: ['@claude:example.org'] }, BOT)
    ).toBe(true);
  });

  it('ignores m.mentions naming somebody else', () => {
    expect(
      isMentioned({ text: 'nothing here', mentionedUserIds: ['@alice:example.org'] }, BOT)
    ).toBe(false);
  });

  it('treats a reply to the bot as a mention', () => {
    expect(isMentioned({ text: 'yes please', replyToSender: '@claude:example.org' }, BOT)).toBe(
      true
    );
  });

  it('does not treat a reply to someone else as a mention', () => {
    expect(isMentioned({ text: 'yes please', replyToSender: '@alice:example.org' }, BOT)).toBe(
      false
    );
  });

  it('finds a matrix.to pill in formatted_body', () => {
    const html = '<a href="https://matrix.to/#/@claude:example.org">Claude</a> ship it';
    expect(isMentioned({ text: 'Claude ship it', html }, BOT)).toBe(true);
  });

  it('matches the full MXID typed in the body', () => {
    expect(isMentioned({ text: 'ping @claude:example.org please' }, BOT)).toBe(true);
  });

  it('matches the localpart with or without an @', () => {
    expect(isMentioned({ text: 'claude can you look' }, BOT)).toBe(true);
    expect(isMentioned({ text: '@claude can you look' }, BOT)).toBe(true);
  });

  it('matches the display name case-insensitively', () => {
    expect(isMentioned({ text: 'hey CLAUDE' }, BOT)).toBe(true);
  });

  it('does not fire on a longer word containing the name', () => {
    expect(isMentioned({ text: 'claudette said no' }, BOT)).toBe(false);
    expect(isMentioned({ text: 'unclaude' }, BOT)).toBe(false);
  });

  it('matches at the very start and the very end of a message', () => {
    expect(isMentioned({ text: 'claude' }, BOT)).toBe(true);
    expect(isMentioned({ text: 'ask claude' }, BOT)).toBe(true);
    expect(isMentioned({ text: 'claude?' }, BOT)).toBe(true);
  });

  it('applies user-supplied patterns', () => {
    const config = { ...BOT, patterns: ['^hey bot\\b'] };
    expect(isMentioned({ text: 'hey bot, status?' }, config)).toBe(true);
    expect(isMentioned({ text: 'not hey bot' }, config)).toBe(false);
  });

  it('skips a pattern that does not compile instead of throwing', () => {
    const config = { ...BOT, patterns: ['([unclosed'] };
    expect(() => isMentioned({ text: 'unrelated' }, config)).not.toThrow();
    expect(isMentioned({ text: 'unrelated' }, config)).toBe(false);
  });

  it('is false for an ordinary message', () => {
    expect(isMentioned({ text: 'lunch at one?' }, BOT)).toBe(false);
  });

  it('works with no display name known', () => {
    expect(isMentioned({ text: 'claude ping' }, { botUserId: '@claude:example.org' })).toBe(true);
  });

  it('does not fire on a display name that is a substring of another word', () => {
    const config = { botUserId: '@bot:example.org', botDisplayName: 'Bo' };
    expect(isMentioned({ text: 'bottle of water' }, config)).toBe(false);
  });
});
