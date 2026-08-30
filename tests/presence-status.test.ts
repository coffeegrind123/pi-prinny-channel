/**
 * The status bubble: what it says, and when it is allowed to say it.
 *
 * THE LOAD-BEARING TEST is "a refused write is retried with the CURRENT status".
 * Presence is rate-limited — measured 429 on a second write ~3s after the first,
 * against the homeserver this was built for — so refusals are normal, not
 * exceptional, and a queue that retried the refused VALUE would publish "reading
 * foo.ts" some seconds after the run had moved on or finished.
 *
 * Its control is "offering the same value twice writes once": a throttle that
 * dropped everything would pass the test above for the wrong reason.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeActivity,
  IDLE,
  MAX_STATUS_CHARS,
  shortPath,
  StatusThrottle,
  THINKING,
  truncate,
} from '../src/presence-status.ts';

describe('what the line says', () => {
  it('names the file for the file tools', () => {
    assert.equal(describeActivity('read', { filePath: '/repo/src/prompt.ts' }), 'reading src/prompt.ts');
    assert.equal(describeActivity('write', { file_path: 'a/b/c.md' }), 'writing b/c.md');
    assert.equal(describeActivity('edit', { path: 'x.ts' }), 'editing x.ts');
  });

  it('shows the command for bash, first line only', () => {
    assert.equal(describeActivity('bash', { command: 'npm test' }), '$ npm test');
    assert.equal(
      describeActivity('bash', { command: 'npm test\nsomething else\nmore' }),
      '$ npm test',
    );
  });

  it('shows the host for a browser call, not the whole URL', () => {
    assert.equal(
      describeActivity('browser_navigate', { url: 'https://boards.4chan.org/g/thread/109684329/lmg' }),
      'browsing boards.4chan.org',
    );
    assert.equal(describeActivity('browser_get_text_content', {}), 'browsing');
  });

  it('describes a subagent by what it was asked to do', () => {
    assert.equal(describeActivity('Agent', { description: 'find the parser' }), 'find the parser');
  });

  // Returning null rather than "working" is deliberate: a vague line replacing a
  // specific one is a downgrade, and it would spend a rate-limited write to do it.
  it('says nothing at all for a tool it does not recognise', () => {
    assert.equal(describeActivity('some_new_tool', { x: 1 }), null);
    assert.equal(describeActivity('', {}), null);
    assert.equal(describeActivity('bash', {}), null);
  });

  it('keeps the line short enough to render inline', () => {
    const long = describeActivity('bash', { command: 'x'.repeat(300) })!;
    assert.ok(long.length <= MAX_STATUS_CHARS, `${long.length} chars`);
    assert.ok(long.endsWith('…'));
    assert.equal(truncate('short'), 'short');
    assert.equal(truncate('a  b\n c'), 'a b c');
  });

  it('shortPath keeps the recognisable tail and rejects nonsense', () => {
    assert.equal(shortPath('/a/b/c/d.ts'), 'c/d.ts');
    assert.equal(shortPath('d.ts'), 'd.ts');
    assert.equal(shortPath(''), null);
    assert.equal(shortPath(undefined), null);
    assert.equal(shortPath(42), null);
  });
});

describe('when it is allowed to say it', () => {
  const on = (statusMsg: string) => ({ presence: 'online' as const, statusMsg });

  it('writes the first one immediately', () => {
    const t = new StatusThrottle(12_000);
    t.offer(on('thinking…'));
    assert.deepEqual(t.due(1000), on('thinking…'));
  });

  it('holds the next one until the interval has passed', () => {
    const t = new StatusThrottle(12_000);
    t.offer(on('a'));
    t.wrote(1000, on('a'));
    t.offer(on('b'));
    assert.equal(t.due(2000), null, 'too soon');
    assert.equal(t.waitMs(2000), 11_000);
    assert.deepEqual(t.due(13_000), on('b'));
  });

  // Latest wins: everything offered while throttled collapses to one write.
  it('collapses a burst to the newest value', () => {
    const t = new StatusThrottle(12_000);
    t.offer(on('a'));
    t.wrote(0, on('a'));
    for (const s of ['b', 'c', 'd', 'e']) t.offer(on(s));
    assert.deepEqual(t.due(12_000), on('e'));
  });

  // THE LOAD-BEARING ONE.
  it('retries a refused write with the CURRENT status, not the refused one', () => {
    const t = new StatusThrottle(12_000);
    t.offer(on('reading foo.ts'));
    assert.deepEqual(t.due(0), on('reading foo.ts'));
    t.rateLimited(0, 5_000);
    assert.equal(t.due(1_000), null, 'still waiting out the 429');
    // The run moved on while we were throttled.
    t.offer(on('running the tests'));
    assert.deepEqual(t.due(5_000), on('running the tests'));
  });

  it("honours the server's retry_after_ms over its own interval", () => {
    const t = new StatusThrottle(12_000);
    t.offer(on('a'));
    t.rateLimited(0, 30_000);
    assert.equal(t.due(12_000), null, 'the server asked for longer than our floor');
    assert.deepEqual(t.due(30_000), on('a'));
  });

  it('falls back to its own interval when the server gives no hint', () => {
    const t = new StatusThrottle(12_000);
    t.offer(on('a'));
    t.rateLimited(0);
    assert.equal(t.due(11_999), null);
    assert.deepEqual(t.due(12_000), on('a'));
  });

  // The control: a throttle that dropped everything would pass the test above.
  it('offering the value already on the server writes nothing', () => {
    const t = new StatusThrottle(12_000);
    t.offer(on('a'));
    t.wrote(0, on('a'));
    t.offer(on('a'));
    assert.equal(t.due(999_999), null);
    assert.equal(t.waitMs(999_999), Infinity);
  });

  it('a value that arrived mid-write is not lost', () => {
    const t = new StatusThrottle(12_000);
    t.offer(on('a'));
    const inFlight = t.due(0)!;
    t.offer(on('b')); // arrived while 'a' was on the wire
    t.wrote(0, inFlight);
    assert.deepEqual(t.due(12_000), on('b'), "'b' must survive the write of 'a'");
  });

  it('clearing the bubble is an ordinary write', () => {
    const t = new StatusThrottle(12_000);
    t.offer(on('busy'));
    t.wrote(0, on('busy'));
    t.offer(on(IDLE));
    assert.deepEqual(t.due(12_000), on(''));
  });

  it('reports what the server was last told', () => {
    const t = new StatusThrottle();
    assert.equal(t.lastWritten(), null);
    t.wrote(0, on(THINKING));
    assert.deepEqual(t.lastWritten(), on('thinking…'));
  });
});
