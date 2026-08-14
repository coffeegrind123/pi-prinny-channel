import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, loadServerModule, RUNTIME_DIST } from './harness.ts';

/**
 * The access module reads its paths at import time, so each test gets a fresh
 * state directory and a fresh module registry. Importing it once and pointing
 * it somewhere else afterwards would silently test the wrong directory.
 */
async function loadModule(stateDir: string) {
  process.env.PRINNY_STATE_DIR = stateDir;
  delete process.env.PRINNY_ACCESS_MODE;
  vi.resetModules();
  return loadServerModule('access');
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'prinny-access-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.PRINNY_STATE_DIR;
  delete process.env.PRINNY_ACCESS_MODE;
});

function writeAccess(dir: string, value: unknown): void {
  writeFileSync(join(dir, 'access.json'), JSON.stringify(value, null, 2));
}

function readAccess(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8'));
}

const DM = { senderId: '@bob:example.org', roomId: '!dm:example.org', isDirect: true, mentionsBot: false };

describe('gate — direct messages', () => {
  it('issues a pairing code for an unknown sender under the default policy', async () => {
    const { gate } = await loadModule(stateDir);
    const result = gate(DM, { newCode: () => 'abc123' });

    expect(result).toEqual({ action: 'pair', code: 'abc123', isResend: false });
    expect(readAccess(stateDir).pending).toHaveProperty('abc123');
  });

  it('records the room on the pending entry so approval can reply there', async () => {
    const { gate } = await loadModule(stateDir);
    gate(DM, { newCode: () => 'abc123' });

    const pending = readAccess(stateDir).pending as Record<string, { roomId: string; senderId: string }>;
    expect(pending.abc123!.roomId).toBe('!dm:example.org');
    expect(pending.abc123!.senderId).toBe('@bob:example.org');
  });

  it('reminds once, then goes silent rather than answering forever', async () => {
    const { gate } = await loadModule(stateDir);
    gate(DM, { newCode: () => 'abc123' });

    expect(gate(DM)).toMatchObject({ action: 'pair', isResend: true });
    expect(gate(DM)).toMatchObject({ action: 'drop' });
    expect(gate(DM)).toMatchObject({ action: 'drop' });
  });

  it('caps concurrent pending pairings', async () => {
    const { gate, MAX_PENDING } = await loadModule(stateDir);
    for (let i = 0; i < MAX_PENDING; i += 1) {
      const result = gate({ ...DM, senderId: `@user${i}:example.org` }, { newCode: () => `code${i}` });
      expect(result.action).toBe('pair');
    }
    expect(gate({ ...DM, senderId: '@overflow:example.org' }).action).toBe('drop');
  });

  it('delivers for an allowlisted sender', async () => {
    writeAccess(stateDir, { dmPolicy: 'pairing', allowFrom: ['@bob:example.org'], rooms: {}, pending: {} });
    const { gate } = await loadModule(stateDir);
    expect(gate(DM).action).toBe('deliver');
  });

  it('drops silently under allowlist — no pairing reply to leak that anything is here', async () => {
    writeAccess(stateDir, { dmPolicy: 'allowlist', allowFrom: [], rooms: {}, pending: {} });
    const { gate } = await loadModule(stateDir);
    expect(gate(DM).action).toBe('drop');
  });

  it('drops allowlisted senders too when disabled', async () => {
    writeAccess(stateDir, { dmPolicy: 'disabled', allowFrom: ['@bob:example.org'], rooms: {}, pending: {} });
    const { gate } = await loadModule(stateDir);
    expect(gate(DM).action).toBe('drop');
  });

  it('expires a pending code and issues a new one', async () => {
    const { gate, PENDING_TTL_MS } = await loadModule(stateDir);
    const start = 1_000_000;
    gate(DM, { now: start, newCode: () => 'old123' });

    const later = gate(DM, { now: start + PENDING_TTL_MS + 1, newCode: () => 'new456' });
    expect(later).toMatchObject({ action: 'pair', code: 'new456', isResend: false });
    expect(readAccess(stateDir).pending).not.toHaveProperty('old123');
  });
});

describe('gate — shared rooms', () => {
  const ROOM = {
    senderId: '@bob:example.org',
    roomId: '!team:example.org',
    isDirect: false,
    mentionsBot: false,
  };

  it('drops messages in a room that was never enabled', async () => {
    writeAccess(stateDir, { dmPolicy: 'pairing', allowFrom: ['@bob:example.org'], rooms: {}, pending: {} });
    const { gate } = await loadModule(stateDir);
    expect(gate(ROOM).action).toBe('drop');
  });

  it('requires a mention by default', async () => {
    writeAccess(stateDir, {
      dmPolicy: 'pairing',
      allowFrom: [],
      rooms: { '!team:example.org': { requireMention: true, allowFrom: [] } },
      pending: {},
    });
    const { gate } = await loadModule(stateDir);
    expect(gate(ROOM).action).toBe('drop');
    expect(gate({ ...ROOM, mentionsBot: true }).action).toBe('deliver');
  });

  it('delivers every message once mention is turned off', async () => {
    writeAccess(stateDir, {
      dmPolicy: 'pairing',
      allowFrom: [],
      rooms: { '!team:example.org': { requireMention: false, allowFrom: [] } },
      pending: {},
    });
    const { gate } = await loadModule(stateDir);
    expect(gate(ROOM).action).toBe('deliver');
  });

  it('restricts triggers to the room allowlist when one is set', async () => {
    writeAccess(stateDir, {
      dmPolicy: 'pairing',
      allowFrom: [],
      rooms: {
        '!team:example.org': { requireMention: false, allowFrom: ['@alice:example.org'] },
      },
      pending: {},
    });
    const { gate } = await loadModule(stateDir);
    expect(gate(ROOM).action).toBe('drop');
    expect(gate({ ...ROOM, senderId: '@alice:example.org' }).action).toBe('deliver');
  });

  it('does not start a pairing from a shared room', async () => {
    const { gate, loadAccess } = await loadModule(stateDir);
    expect(gate(ROOM).action).toBe('drop');
    // Nothing was written at all — a drop in a shared room must not create
    // state, or a busy room would fill the pending list and lock out real DMs.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(stateDir, 'access.json'))).toBe(false);
    expect(loadAccess().pending).toEqual({});
  });
});

describe('access file handling', () => {
  it('treats a missing file as the pairing default', async () => {
    const { loadAccess } = await loadModule(stateDir);
    expect(loadAccess()).toEqual({
      dmPolicy: 'pairing',
      allowFrom: [],
      rooms: {},
      pending: {},
    });
  });

  it('quarantines a corrupt file instead of refusing to run', async () => {
    writeFileSync(join(stateDir, 'access.json'), '{ this is not json');
    const { loadAccess } = await loadModule(stateDir);

    expect(loadAccess().dmPolicy).toBe('pairing');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(stateDir).some((f) => f.startsWith('access.json.corrupt-'))).toBe(true);
  });

  it('fills in defaults for keys a hand-edit left out', async () => {
    writeAccess(stateDir, { allowFrom: ['@bob:example.org'] });
    const { loadAccess } = await loadModule(stateDir);
    const access = loadAccess();

    expect(access.dmPolicy).toBe('pairing');
    expect(access.rooms).toEqual({});
    expect(access.pending).toEqual({});
    expect(access.allowFrom).toEqual(['@bob:example.org']);
  });
});

describe('static mode', () => {
  it('downgrades pairing to allowlist rather than handing out dead codes', async () => {
    writeAccess(stateDir, { dmPolicy: 'pairing', allowFrom: [], rooms: {}, pending: {} });
    process.env.PRINNY_STATE_DIR = stateDir;
    process.env.PRINNY_ACCESS_MODE = 'static';
    vi.resetModules();
    const { gate, loadAccess } = await loadServerModule('access');

    expect(loadAccess().dmPolicy).toBe('allowlist');
    expect(gate(DM).action).toBe('drop');
  });

  it('never writes to disk', async () => {
    writeAccess(stateDir, { dmPolicy: 'allowlist', allowFrom: ['@bob:example.org'], rooms: {}, pending: {} });
    process.env.PRINNY_STATE_DIR = stateDir;
    process.env.PRINNY_ACCESS_MODE = 'static';
    vi.resetModules();
    const { saveAccess, loadAccess } = await loadServerModule('access');

    const access = loadAccess();
    access.allowFrom.push('@mallory:example.org');
    saveAccess(access);

    expect(readAccess(stateDir).allowFrom).toEqual(['@bob:example.org']);
  });
});

describe('assertAllowedRoom', () => {
  it('accepts an enabled room', async () => {
    writeAccess(stateDir, {
      dmPolicy: 'pairing',
      allowFrom: [],
      rooms: { '!team:example.org': { requireMention: true, allowFrom: [] } },
      pending: {},
    });
    const { assertAllowedRoom } = await loadModule(stateDir);
    expect(() => assertAllowedRoom('!team:example.org', new Set())).not.toThrow();
  });

  it('accepts a direct room with an allowlisted sender', async () => {
    const { assertAllowedRoom } = await loadModule(stateDir);
    expect(() => assertAllowedRoom('!dm:example.org', new Set(['!dm:example.org']))).not.toThrow();
  });

  it('refuses any other room, so an injected room ID cannot be posted to', async () => {
    const { assertAllowedRoom } = await loadModule(stateDir);
    expect(() => assertAllowedRoom('!elsewhere:example.org', new Set())).toThrow(
      /not allowlisted/
    );
  });
});

describe('commandGate', () => {
  it('answers a sender who is mid-pairing, so they can re-read their code', async () => {
    const { gate, commandGate } = await loadModule(stateDir);
    gate(DM, { newCode: () => 'abc123' });

    const gated = commandGate({ senderId: '@bob:example.org', isDirect: true });
    expect(gated?.access.pending).toHaveProperty('abc123');
  });

  it('never answers in a shared room', async () => {
    const { commandGate } = await loadModule(stateDir);
    expect(commandGate({ senderId: '@bob:example.org', isDirect: false })).toBeNull();
  });

  it('stays silent under allowlist for someone not on it', async () => {
    writeAccess(stateDir, { dmPolicy: 'allowlist', allowFrom: [], rooms: {}, pending: {} });
    const { commandGate } = await loadModule(stateDir);
    expect(commandGate({ senderId: '@bob:example.org', isDirect: true })).toBeNull();
  });
});

describe('checkApprovals', () => {
  it('confirms in the room the skill recorded, then clears the marker', async () => {
    const { checkApprovals, encodeSenderFilename } = await loadModule(stateDir);
    const approved = join(stateDir, 'approved');
    mkdirSync(approved, { recursive: true });
    writeFileSync(join(approved, encodeSenderFilename('@bob:example.org')), '!dm:example.org');

    const sent: Array<[string, string]> = [];
    checkApprovals(async (roomId, text) => {
      sent.push([roomId, text]);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe('!dm:example.org');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(approved)).toEqual([]);
  });

  it('does nothing when there is no approvals directory', async () => {
    const { checkApprovals } = await loadModule(stateDir);
    expect(() => checkApprovals(async () => undefined)).not.toThrow();
  });
});

describe('encodeSenderFilename', () => {
  it('encodes the characters an MXID has that a filename cannot', async () => {
    const { encodeSenderFilename } = await loadModule(stateDir);
    const encoded = encodeSenderFilename('@bob:example.org');
    expect(encoded).not.toContain(':');
    expect(encoded).not.toContain('/');
    expect(decodeURIComponent(encoded)).toBe('@bob:example.org');
  });
});
