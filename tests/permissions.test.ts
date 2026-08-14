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
