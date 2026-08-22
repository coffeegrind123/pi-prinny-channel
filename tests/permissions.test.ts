import { readFileSync } from 'node:fs';

import { describe, expect, it, loadServerModule, RUNTIME_DIST } from './harness.ts';

const { PERMISSION_CALLBACK_RE, parsePermissionReply } = await loadServerModule<{
  PERMISSION_CALLBACK_RE: RegExp;
  parsePermissionReply: (text: string) => { requestId: string; behavior: string } | null;
}>('permissions');

describe('parsePermissionReply', () => {
  it('accepts the short forms', () => {
    expect(parsePermissionReply('y abcde')).toEqual({ requestId: 'abcde', behavior: 'allow' });
    expect(parsePermissionReply('n abcde')).toEqual({ requestId: 'abcde', behavior: 'deny' });
  });

  it('accepts the long forms', () => {
    expect(parsePermissionReply('yes abcde')).toEqual({ requestId: 'abcde', behavior: 'allow' });
    expect(parsePermissionReply('no abcde')).toEqual({ requestId: 'abcde', behavior: 'deny' });
  });

  it('lowercases what a phone keyboard capitalised', () => {
    expect(parsePermissionReply('Yes ABCDE')).toEqual({ requestId: 'abcde', behavior: 'allow' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePermissionReply('  y abcde  ')).toEqual({ requestId: 'abcde', behavior: 'allow' });
  });

  it('rejects a bare yes — conversation must not approve a tool call', () => {
    expect(parsePermissionReply('yes')).toBeNull();
    expect(parsePermissionReply('no')).toBeNull();
    expect(parsePermissionReply('yes please')).toBeNull();
  });

  it('rejects chatter around a valid code', () => {
    expect(parsePermissionReply('ok y abcde')).toBeNull();
    expect(parsePermissionReply('y abcde thanks')).toBeNull();
  });

  it("rejects a code containing 'l', which the alphabet excludes", () => {
    expect(parsePermissionReply('y abcdl')).toBeNull();
  });

  it('rejects codes of the wrong length', () => {
    expect(parsePermissionReply('y abcd')).toBeNull();
    expect(parsePermissionReply('y abcdef')).toBeNull();
  });

  it('rejects digits and punctuation in the code', () => {
    expect(parsePermissionReply('y abc12')).toBeNull();
    expect(parsePermissionReply('y abc-e')).toBeNull();
  });

  it('returns null for ordinary messages', () => {
    expect(parsePermissionReply('can you run the tests')).toBeNull();
    expect(parsePermissionReply('')).toBeNull();
  });
});

describe('PERMISSION_CALLBACK_RE', () => {
  it('parses each button', () => {
    expect(PERMISSION_CALLBACK_RE.exec('perm:allow:abcde')?.slice(1)).toEqual(['allow', 'abcde']);
    expect(PERMISSION_CALLBACK_RE.exec('perm:deny:abcde')?.slice(1)).toEqual(['deny', 'abcde']);
    expect(PERMISSION_CALLBACK_RE.exec('perm:more:abcde')?.slice(1)).toEqual(['more', 'abcde']);
  });

  it('rejects anything else, so an unrelated callback cannot decide a permission', () => {
    expect(PERMISSION_CALLBACK_RE.test('perm:allow:abcd')).toBe(false);
    expect(PERMISSION_CALLBACK_RE.test('perm:elevate:abcde')).toBe(false);
    expect(PERMISSION_CALLBACK_RE.test('deploy:yes')).toBe(false);
    expect(PERMISSION_CALLBACK_RE.test('xperm:allow:abcde')).toBe(false);
  });
});

/**
 * AK4 — a prompt nobody can answer any more must not report an outcome.
 *
 * The extension's `requestApproval` fails closed after
 * `permissionTimeoutSeconds`: it drops its own entry, resolves `timeout`, and
 * the tool call is BLOCKED. It tells the sidecar nothing. Before this class,
 * the sidecar's map kept the prompt for the life of the process, so:
 *
 *   - every unanswered prompt leaked one entry holding up to 4,000 characters
 *     of `input_preview` — for a `write`, the whole file;
 *   - the Allow button stayed live in every paired sender's room, and pressing
 *     it answered `✅ Allowed` and edited the room's record to say so, for a
 *     command that had already been blocked. The extension logs the late reply
 *     as an unknown request and does nothing — so the only lasting account of
 *     what happened was the one in the room, and it was the opposite of true.
 */
const { PermissionRegistry, DEFAULT_PERMISSION_TTL_MS, EXPIRED_PERMISSION_MESSAGE } =
  await loadServerModule<{
    PermissionRegistry: new () => {
      add: (id: string, prompt: Record<string, string>, ttlMs?: number, now?: number) => void;
      live: (id: string, now?: number) => Record<string, string> | undefined;
      remove: (id: string) => void;
      sweep: (now?: number) => void;
      readonly size: number;
    };
    DEFAULT_PERMISSION_TTL_MS: number;
    EXPIRED_PERMISSION_MESSAGE: string;
  }>('permissions');

const PROMPT = { tool_name: 'bash', description: 'recursive force delete: rm -rf /x', input_preview: '{}' };

describe('PermissionRegistry', () => {
  it('answers a prompt that is still waiting', () => {
    const registry = new PermissionRegistry();
    registry.add('abcde', PROMPT, 60_000, 1_000);
    expect(registry.live('abcde', 2_000)).toEqual(PROMPT);
  });

  it('stops answering the moment pi stops waiting', () => {
    const registry = new PermissionRegistry();
    registry.add('abcde', PROMPT, 60_000, 1_000);
    // One millisecond before: still live. At the deadline: gone. The two sides
    // stop waiting at the same instant, which is why the extension sends
    // `timeout_ms` rather than letting this side guess.
    expect(registry.live('abcde', 60_999)).toEqual(PROMPT);
    expect(registry.live('abcde', 61_000)).toBeUndefined();
  });

  it('drops the entry when it expires, so the preview does not outlive the call', () => {
    const registry = new PermissionRegistry();
    registry.add('abcde', PROMPT, 1_000, 0);
    expect(registry.size).toBe(1);
    registry.live('abcde', 5_000);
    expect(registry.size).toBe(0);
  });

  it('sweeps on every arrival, so an unattended run cannot fill the map', () => {
    const registry = new PermissionRegistry();
    for (let i = 0; i < 50; i++) registry.add(`id${i}`, PROMPT, 1_000, i);
    expect(registry.size).toBe(50);
    // One later prompt, after every earlier one has expired.
    registry.add('later', PROMPT, 1_000, 10_000);
    expect(registry.size).toBe(1);
  });

  it('falls back to the extension default when told no timeout', () => {
    const registry = new PermissionRegistry();
    registry.add('abcde', PROMPT, undefined, 0);
    expect(registry.live('abcde', DEFAULT_PERMISSION_TTL_MS - 1)).toEqual(PROMPT);
    expect(registry.live('abcde', DEFAULT_PERMISSION_TTL_MS)).toBeUndefined();
  });

  it('ignores a timeout that is not a positive number', () => {
    const registry = new PermissionRegistry();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      registry.add('abcde', PROMPT, bad as number, 0);
      expect(registry.live('abcde', DEFAULT_PERMISSION_TTL_MS - 1)).toEqual(PROMPT);
    }
  });

  it('a decided prompt cannot be answered a second time', () => {
    const registry = new PermissionRegistry();
    registry.add('abcde', PROMPT, 60_000, 0);
    registry.remove('abcde');
    expect(registry.live('abcde', 1_000)).toBeUndefined();
  });

  it('says what happened to the CALL, not just to the prompt', () => {
    // "no longer waiting" on its own reads as a UI glitch. The reader needs to
    // know nothing ran.
    expect(EXPIRED_PERMISSION_MESSAGE).toContain('blocked the call');
    expect(EXPIRED_PERMISSION_MESSAGE).toContain('Nothing was run');
  });
});

describe('the sidecar answers a dead prompt honestly (AK4)', () => {
  it('reads the prompt through live(), and says so when it is gone', () => {
    const src = readFileSync(new URL('../server/src/server.ts', import.meta.url), 'utf8');
    // The decision path must not reach `decidePermission` for a prompt that is
    // no longer live, and must not print "✅ Allowed" for one either.
    const decision = src.slice(src.indexOf('// Read before deciding'));
    const guard = decision.indexOf('pendingPermissions.live(requestId)');
    const decide = decision.indexOf('decidePermission(requestId, behavior)');
    const label = decision.indexOf("'✅ Allowed'");
    expect(guard >= 0 && decide > guard && label > guard).toBe(true);
    expect(decision.includes('EXPIRED_PERMISSION_MESSAGE')).toBe(true);
  });

  it('tells the sidecar how long it will wait', () => {
    const src = readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf8');
    const request = src.slice(src.indexOf("'notifications/claude/channel/permission_request'"));
    expect(request.slice(0, 600).includes('timeout_ms: timeoutMs')).toBe(true);
  });
});
