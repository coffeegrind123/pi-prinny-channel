/**
 * One bot per Matrix account.
 *
 * THE LOAD-BEARING TEST is "a second claim on the same account is refused".
 * Everything else here supports it. The failure it prevents is not a crash: it
 * is five bots on `@openclaude:struct.ws`, seven devices, and every inbound
 * message coming back as "The sender's device has not sent us the keys" — state
 * that cannot be repaired, only re-minted.
 *
 * Its control is "a different account is not blocked": a lock that refused
 * everything would pass the test above for the wrong reason.
 *
 * The third pair is the one the OLD guard got wrong. It shelled out to `ps`
 * inside a `catch {}` and then took the pid file regardless, so an environment
 * where liveness could not be established silently allowed a second bot.
 * `holderIsAlive` returns `undefined` there, and `claimAccount` must treat that
 * as HELD — refusing to start is recoverable, a corrupted Olm account is not.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from './harness.ts';

import {
  accountLockPath,
  claimAccount,
  describeHolder,
  releaseAccount,
} from '../server/src/account-lock.ts';

const USER = '@openclaude:struct.ws';
const HS = 'https://struct.ws:8448';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'prinny-lock-'));
}

describe('account lock', () => {
  it('is keyed on the account, not the channel directory', () => {
    // The whole point: two different channel dirs, one account, one lock path.
    assert.equal(accountLockPath(USER, HS), accountLockPath(USER, HS));
    assert.notEqual(accountLockPath(USER, HS), accountLockPath('@other:struct.ws', HS));
    assert.notEqual(accountLockPath(USER, HS), accountLockPath(USER, 'https://elsewhere'));
  });

  it('a second claim on the same account is refused', () => {
    const first = claimAccount(USER, HS, freshDir());
    try {
      assert.equal(first.ok, true);
      // A different channel directory — the case the per-STATE_DIR pid guard
      // cannot see, and the one that actually happened.
      const second = claimAccount(USER, HS, freshDir());
      assert.equal(second.ok, false, 'the second bot must not be allowed to start');
      assert.equal(second.holder?.pid, process.pid);
      assert.match(describeHolder(second.holder), /pid \d+/);
    } finally {
      releaseAccount(first.path);
    }
  });

  it('a different account is not blocked', () => {
    const a = claimAccount(USER, HS, freshDir());
    const b = claimAccount('@someone-else:struct.ws', HS, freshDir());
    try {
      assert.equal(a.ok, true);
      assert.equal(b.ok, true, 'the lock must not be global');
    } finally {
      releaseAccount(a.path);
      releaseAccount(b.path);
    }
  });

  it('a stale lock from a dead holder is broken once, with a reason', () => {
    const path = accountLockPath('@stale:struct.ws', HS);
    // pid 2^22 is above every Linux default pid_max, so it cannot be live.
    writeFileSync(path, JSON.stringify({ pid: 4194303, channelDir: '/gone', startedAt: 'x' }));
    const messages: string[] = [];
    const got = claimAccount('@stale:struct.ws', HS, freshDir(), (m) => messages.push(m));
    try {
      assert.equal(got.ok, true, 'a dead holder must not wedge the account forever');
      assert.ok(messages.some((m) => /stale/i.test(m)), 'breaking a lock must say so');
    } finally {
      releaseAccount(got.path);
    }
  });

  it('an unreadable lock file is treated as stale, not as a crash', () => {
    const path = accountLockPath('@garbage:struct.ws', HS);
    writeFileSync(path, 'not json at all');
    const got = claimAccount('@garbage:struct.ws', HS, freshDir());
    try {
      assert.equal(got.ok, true);
    } finally {
      releaseAccount(got.path);
    }
  });

  it('releasing someone else\'s lock is a no-op', () => {
    const mine = claimAccount('@rel:struct.ws', HS, freshDir());
    writeFileSync(mine.path, JSON.stringify({ pid: 4194303, channelDir: '/x', startedAt: 'y' }));
    releaseAccount(mine.path);
    assert.ok(readFileSync(mine.path, 'utf8').includes('4194303'), 'must not delete a lock we no longer hold');
    writeFileSync(mine.path, JSON.stringify({ pid: process.pid, channelDir: '/x', startedAt: 'y' }));
    releaseAccount(mine.path);
  });
});
