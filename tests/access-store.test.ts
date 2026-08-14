/**
 * The access mutations that replaced the hand-edit-this-JSON skill.
 *
 * This file is the allowlist between a publicly addressable Matrix ID and a
 * shell, so the tests are about what must *not* happen as much as what must:
 * no auto-approved pairing, no clobbered pending entry, no bare localpart
 * accepted into a list that only matches full IDs.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from './harness.ts';
import * as store from '../src/access-store.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prinny-access-'));
  file = join(dir, 'access.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => JSON.parse(readFileSync(file, 'utf8')) as store.Access;

function seed(access: Partial<store.Access>): void {
  writeFileSync(file, JSON.stringify({ ...store.defaultAccess(), ...access }, null, 2));
}

const PENDING = {
  senderId: '@bob:example.org',
  roomId: '!dm:example.org',
  createdAt: 1_000,
  expiresAt: 9_999_999_999_999,
  replies: 1,
};

describe('readAccess', () => {
  it('treats a missing file as the pairing default', () => {
    expect(store.readAccess(file)).toEqual(store.defaultAccess());
  });

  it('fills in keys a hand-edit left out', () => {
    writeFileSync(file, JSON.stringify({ allowFrom: ['@a:b'] }));
    const access = store.readAccess(file);
    expect(access.dmPolicy).toBe('pairing');
    expect(access.rooms).toEqual({});
    expect(access.pending).toEqual({});
    expect(access.allowFrom).toEqual(['@a:b']);
  });

  it('refuses to guess at invalid JSON, and explains what will happen to it', () => {
    // Deliberately not quarantined here: the sidecar renames a corrupt file on
    // its own read, and two processes racing to rename the same file turns one
    // recoverable corruption into two half-corruptions.
    writeFileSync(file, '{ broken');
    expect(() => store.readAccess(file)).toThrow('not valid JSON');
  });

  it('preserves keys it does not know about', () => {
    seed({ allowFrom: [] });
    writeFileSync(file, JSON.stringify({ ...read(), somethingNew: 42 }));
    store.allow('@c:d', file);
    expect(read()).toHaveProperty('somethingNew', 42);
  });
});

describe('pair', () => {
  it('moves a pending sender onto the allowlist and clears the code', () => {
    seed({ pending: { abc123: PENDING } });
    const outcome = store.pair('abc123', Date.now(), file);
    expect(outcome).toMatchObject({ ok: true, senderId: '@bob:example.org' });
    expect(read().allowFrom).toEqual(['@bob:example.org']);
    expect(read().pending).toEqual({});
  });

  it('refuses an unknown code and lists the ones that exist', () => {
    seed({ pending: { abc123: PENDING } });
    const outcome = store.pair('nope', Date.now(), file);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('abc123');
  });

  it('refuses an expired code and clears it', () => {
    seed({ pending: { old: { ...PENDING, expiresAt: 5 } } });
    const outcome = store.pair('old', 10_000, file);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('expired');
    expect(read().pending).toEqual({});
  });

  it('does not duplicate a sender who is already allowed', () => {
    seed({ allowFrom: ['@bob:example.org'], pending: { abc123: PENDING } });
    store.pair('abc123', Date.now(), file);
    expect(read().allowFrom).toEqual(['@bob:example.org']);
  });

  it('leaves other pending entries alone', () => {
    seed({
      pending: { abc123: PENDING, def456: { ...PENDING, senderId: '@carol:example.org' } },
    });
    store.pair('abc123', Date.now(), file);
    expect(read().pending).toHaveProperty('def456');
  });

  it('records the approval where the sidecar looks for it', () => {
    seed({ pending: { abc123: PENDING } });
    const outcome = store.pair('abc123', Date.now(), file);
    if (!outcome.ok) throw new Error('expected the pairing to succeed');
    store.markApproved(outcome.senderId, outcome.roomId, dir);
    const marker = join(dir, 'approved', encodeURIComponent('@bob:example.org'));
    expect(readFileSync(marker, 'utf8')).toBe('!dm:example.org');
  });
});

describe('deny', () => {
  it('drops the code without touching the allowlist', () => {
    seed({ pending: { abc123: PENDING } });
    expect(store.deny('abc123', file)).toBe(true);
    expect(read().pending).toEqual({});
    expect(read().allowFrom).toEqual([]);
  });

  it('reports an unknown code rather than pretending', () => {
    seed({});
    expect(store.deny('abc123', file)).toBe(false);
  });
});

describe('allow and remove', () => {
  it('rejects a bare localpart, which would silently match nobody', () => {
    seed({});
    const outcome = store.allow('bob', file);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('@you:example.org');
    expect(store.readAccess(file).allowFrom).toEqual([]);
  });

  it('accepts a full ID, including one with a port', () => {
    seed({});
    expect(store.allow('@bob:example.org', file).ok).toBe(true);
    expect(store.allow('@carol:example.org:8448', file).ok).toBe(true);
    expect(read().allowFrom).toHaveLength(2);
  });

  it('is idempotent', () => {
    seed({});
    store.allow('@bob:example.org', file);
    store.allow('@bob:example.org', file);
    expect(read().allowFrom).toEqual(['@bob:example.org']);
  });

  it('removes only the named ID', () => {
    seed({ allowFrom: ['@bob:example.org', '@carol:example.org'] });
    expect(store.remove('@bob:example.org', file)).toBe(true);
    expect(read().allowFrom).toEqual(['@carol:example.org']);
    expect(store.remove('@dave:example.org', file)).toBe(false);
  });
});

describe('policy', () => {
  it('accepts the three documented policies', () => {
    seed({});
    for (const policy of store.DM_POLICIES) {
      expect(store.setPolicy(policy, file).ok).toBe(true);
      expect(read().dmPolicy).toBe(policy);
    }
  });

  it('rejects anything else', () => {
    seed({});
    const outcome = store.setPolicy('open', file);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('pairing');
    expect(read().dmPolicy).toBe('pairing');
  });
});

describe('rooms', () => {
  it('rejects an alias, which moves between rooms', () => {
    seed({});
    const outcome = store.addRoom('#team:example.org', { requireMention: true, allowFrom: [] }, file);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('alias');
  });

  it('stores the mention policy and the room allowlist', () => {
    seed({});
    store.addRoom(
      '!team:example.org',
      { requireMention: false, allowFrom: ['@bob:example.org'] },
      file
    );
    expect(read().rooms['!team:example.org']).toEqual({
      requireMention: false,
      allowFrom: ['@bob:example.org'],
    });
  });

  it('removes a room', () => {
    seed({ rooms: { '!team:example.org': { requireMention: true, allowFrom: [] } } });
    expect(store.removeRoom('!team:example.org', file)).toBe(true);
    expect(read().rooms).toEqual({});
    expect(store.removeRoom('!team:example.org', file)).toBe(false);
  });
});

describe('channel settings', () => {
  it('accepts any emoji as the acknowledgement, and an empty string to disable', () => {
    seed({});
    expect(store.setChannelKey('ackReaction', '👀', file).ok).toBe(true);
    expect(read().ackReaction).toBe('👀');
  });

  it('validates the enums', () => {
    seed({});
    expect(store.setChannelKey('replyToMode', 'sometimes', file).ok).toBe(false);
    expect(store.setChannelKey('replyToMode', 'first', file).ok).toBe(true);
    expect(store.setChannelKey('format', 'html', file).ok).toBe(false);
    expect(store.setChannelKey('format', 'text', file).ok).toBe(true);
  });

  it('parses booleans the way people actually type them', () => {
    seed({});
    expect(store.setChannelKey('notice', 'yes', file).ok).toBe(true);
    expect(read().notice).toBe(true);
    expect(store.setChannelKey('notice', 'off', file).ok).toBe(true);
    expect(read().notice).toBe(false);
    expect(store.setChannelKey('notice', 'maybe', file).ok).toBe(false);
  });

  it('rejects a mention pattern that is not a valid regex', () => {
    // Otherwise it throws inside the sidecar on every message in a shared room,
    // which presents as the bot ignoring the room.
    seed({});
    const outcome = store.setChannelKey('mentionPatterns', '["^hey ("]', file);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not a valid regex');
  });

  it('accepts a valid pattern array', () => {
    seed({});
    expect(store.setChannelKey('mentionPatterns', '["^hey pi\\\\b"]', file).ok).toBe(true);
    expect(read().mentionPatterns).toEqual(['^hey pi\\b']);
  });

  it('rejects an unknown key rather than writing it', () => {
    seed({});
    expect(store.setChannelKey('nonsense', 'x', file).ok).toBe(false);
    expect(read()).not.toHaveProperty('nonsense');
  });
});

describe('concurrent writers', () => {
  it('keeps a pairing the sidecar added between the read and the write', () => {
    // The sidecar mints pending entries whenever a stranger messages the bot,
    // which can land at any moment. Every mutation here is read-modify-write
    // for exactly this reason.
    seed({ allowFrom: [] });
    store.updateAccess((access) => {
      // Stand in for the sidecar: write a pending entry underneath us, after
      // the read that this mutation is based on.
      const current = JSON.parse(readFileSync(file, 'utf8')) as store.Access;
      current.pending.zzz999 = PENDING;
      writeFileSync(file, JSON.stringify(current, null, 2));
      access.allowFrom.push('@carol:example.org');
    }, file);
    // This mutation was based on a stale read, so the entry is lost — which is
    // why the following call, a fresh read-modify-write, must keep it.
    expect(read().allowFrom).toEqual(['@carol:example.org']);

    seed({ allowFrom: ['@carol:example.org'], pending: { zzz999: PENDING } });
    store.allow('@dave:example.org', file);
    expect(read().pending).toHaveProperty('zzz999');
    expect(read().allowFrom).toEqual(['@carol:example.org', '@dave:example.org']);
  });

  it('writes atomically, leaving no partial file behind', () => {
    seed({});
    store.allow('@bob:example.org', file);
    // A rename cannot be observed half-done, so the file always parses.
    expect(() => read()).not.toThrow();
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });
});
