import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, loadServerModule, RUNTIME_DIST } from './harness.ts';

async function loadModule(stateDir: string) {
  process.env.PRINNY_STATE_DIR = stateDir;
  vi.resetModules();
  return loadServerModule('inbox');
}

let stateDir: string;
let workDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'prinny-state-'));
  workDir = mkdtempSync(join(tmpdir(), 'prinny-work-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.PRINNY_STATE_DIR;
});

describe('assertSendable', () => {
  it('allows an ordinary file outside the state directory', async () => {
    const { assertSendable } = await loadModule(stateDir);
    const file = join(workDir, 'report.pdf');
    writeFileSync(file, 'x');
    expect(() => assertSendable(file)).not.toThrow();
  });

  it('refuses the credentials file', async () => {
    const { assertSendable } = await loadModule(stateDir);
    const env = join(stateDir, '.env');
    writeFileSync(env, 'PRINNY_ACCESS_TOKEN=secret');
    expect(() => assertSendable(env)).toThrow(/refusing to send channel state/);
  });

  it('refuses the allowlist', async () => {
    const { assertSendable } = await loadModule(stateDir);
    const access = join(stateDir, 'access.json');
    writeFileSync(access, '{}');
    expect(() => assertSendable(access)).toThrow(/refusing to send channel state/);
  });

  it('refuses the crypto store, which holds the bot identity', async () => {
    const { assertSendable } = await loadModule(stateDir);
    mkdirSync(join(stateDir, 'crypto'), { recursive: true });
    const snapshot = join(stateDir, 'crypto', 'snapshot.json');
    writeFileSync(snapshot, '{}');
    expect(() => assertSendable(snapshot)).toThrow(/refusing to send channel state/);
  });

  it('allows the inbox, which is where inbound attachments legitimately live', async () => {
    const { assertSendable } = await loadModule(stateDir);
    mkdirSync(join(stateDir, 'inbox'), { recursive: true });
    const file = join(stateDir, 'inbox', 'photo.png');
    writeFileSync(file, 'x');
    expect(() => assertSendable(file)).not.toThrow();
  });

  it('sees through a symlink pointing back into the state directory', async () => {
    const { assertSendable } = await loadModule(stateDir);
    const env = join(stateDir, '.env');
    writeFileSync(env, 'PRINNY_ACCESS_TOKEN=secret');
    const bait = join(workDir, 'innocent.txt');
    symlinkSync(env, bait);
    expect(() => assertSendable(bait)).toThrow(/refusing to send channel state/);
  });

  it('does not throw for a path that does not exist — the size check reports that', async () => {
    const { assertSendable } = await loadModule(stateDir);
    expect(() => assertSendable(join(workDir, 'absent.txt'))).not.toThrow();
  });
});

describe('assertWithinSizeLimit', () => {
  it('accepts a small file', async () => {
    const { assertWithinSizeLimit } = await loadModule(stateDir);
    const file = join(workDir, 'small.bin');
    writeFileSync(file, Buffer.alloc(1024));
    expect(() => assertWithinSizeLimit(file)).not.toThrow();
  });

  it('reports a missing file rather than passing it through', async () => {
    const { assertWithinSizeLimit } = await loadModule(stateDir);
    expect(() => assertWithinSizeLimit(join(workDir, 'absent.bin'))).toThrow();
  });
});

describe('kindForPath', () => {
  it('classifies by extension so clients render inline', async () => {
    const { kindForPath } = await loadModule(stateDir);
    expect(kindForPath('/tmp/a.PNG')).toBe('image');
    expect(kindForPath('/tmp/a.webp')).toBe('image');
    expect(kindForPath('/tmp/a.mp4')).toBe('video');
    expect(kindForPath('/tmp/a.ogg')).toBe('audio');
    expect(kindForPath('/tmp/a.pdf')).toBe('file');
    expect(kindForPath('/tmp/noext')).toBe('file');
  });
});

describe('sanitizeName', () => {
  it('strips the delimiters that would break out of the channel tag', async () => {
    const { sanitizeName } = await loadModule(stateDir);
    expect(sanitizeName('a<b>c[d]e;f')).toBe('a_b_c_d_e_f');
  });

  it('strips path separators, so a filename cannot escape the inbox', async () => {
    const { sanitizeName } = await loadModule(stateDir);
    expect(sanitizeName('../../etc/passwd')).toBe('.._.._etc_passwd');
  });

  it('strips newlines, which could forge a second meta line', async () => {
    const { sanitizeName } = await loadModule(stateDir);
    expect(sanitizeName('name\nuser=@evil:example.org')).toBe('name_user=@evil:example.org');
  });

  it('returns undefined for nothing', async () => {
    const { sanitizeName } = await loadModule(stateDir);
    expect(sanitizeName(undefined)).toBeUndefined();
    expect(sanitizeName('')).toBeUndefined();
  });
});

describe('writeToInbox', () => {
  it('writes under the event id so a repeat download does not pile up copies', async () => {
    const { writeToInbox } = await loadModule(stateDir);
    const first = writeToInbox(Buffer.from('hello'), 'photo.png', '$abc123:example.org');
    const second = writeToInbox(Buffer.from('hello'), 'photo.png', '$abc123:example.org');

    expect(first).toBe(second);
    expect(readFileSync(first, 'utf8')).toBe('hello');
  });

  it('keeps a hostile filename inside the inbox', async () => {
    const { writeToInbox } = await loadModule(stateDir);
    const path = writeToInbox(Buffer.from('x'), '../../escape.txt', '$evt:example.org');
    expect(path.startsWith(join(stateDir, 'inbox'))).toBe(true);
  });
});
