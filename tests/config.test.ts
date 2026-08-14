/**
 * Settings, and the one rule this file duplicates from the sidecar.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, loadServerModule, vi } from './harness.ts';
import { DEFAULT_SETTINGS, parseSetting, readSettings, stateDir, writeSettings } from '../src/config.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prinny-config-'));
  file = join(dir, 'pi.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readSettings', () => {
  it('returns the documented defaults when nothing has been written', () => {
    expect(readSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it('forwards the turn result by default, because a small model does not call the tool', () => {
    expect(DEFAULT_SETTINGS.forward).toBe('result');
  });

  it('leaves the permission relay off by default', () => {
    expect(DEFAULT_SETTINGS.permissionMode).toBe('off');
  });

  it('reads back what was written', () => {
    writeSettings({ ...DEFAULT_SETTINGS, forward: 'all', permissionMode: 'dangerous' }, file);
    const settings = readSettings(file);
    expect(settings.forward).toBe('all');
    expect(settings.permissionMode).toBe('dangerous');
  });

  it('falls back per key, so one bad value does not reset the rest', () => {
    // Notably: a typo in `forward` must not quietly turn the permission gate
    // off, which a whole-object fallback would do.
    writeFileSync(
      file,
      JSON.stringify({ forward: 'nonsense', permissionMode: 'all', permissionTimeoutSeconds: -5 })
    );
    const settings = readSettings(file);
    expect(settings.forward).toBe(DEFAULT_SETTINGS.forward);
    expect(settings.permissionMode).toBe('all');
    expect(settings.permissionTimeoutSeconds).toBe(DEFAULT_SETTINGS.permissionTimeoutSeconds);
  });

  it('treats an unreadable file as defaults rather than as a crash', () => {
    writeFileSync(file, '{ not json');
    expect(readSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it('drops non-string entries from the always-ask list', () => {
    writeFileSync(file, JSON.stringify({ permissionTools: ['bash', 7, null, 'write'] }));
    expect(readSettings(file).permissionTools).toEqual(['bash', 'write']);
  });
});

describe('parseSetting', () => {
  it('accepts the documented enums', () => {
    expect(parseSetting('forward', 'all')).toMatchObject({ ok: true, value: 'all' });
    expect(parseSetting('deliverAs', 'steer')).toMatchObject({ ok: true, value: 'steer' });
    expect(parseSetting('permissionMode', 'dangerous')).toMatchObject({ ok: true });
  });

  it('rejects a value outside the enum, and says what was expected', () => {
    const outcome = parseSetting('forward', 'sometimes');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('off | result | all');
      expect(outcome.error).toContain('sometimes');
    }
  });

  it('parses a comma list into tool names', () => {
    expect(parseSetting('permissionTools', ' bash , write ,')).toMatchObject({
      ok: true,
      value: ['bash', 'write'],
    });
  });

  it('rejects a non-positive timeout', () => {
    expect(parseSetting('permissionTimeoutSeconds', '0').ok).toBe(false);
    expect(parseSetting('permissionTimeoutSeconds', 'soon').ok).toBe(false);
    expect(parseSetting('permissionTimeoutSeconds', '90')).toMatchObject({ ok: true, value: 90 });
  });

  it('names the known keys when given an unknown one', () => {
    const outcome = parseSetting('nope', 'x');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('forward');
  });
});

describe('state directory', () => {
  it('honours PRINNY_STATE_DIR above everything', () => {
    expect(stateDir({ PRINNY_STATE_DIR: '/custom' } as NodeJS.ProcessEnv)).toBe('/custom');
  });

  it('follows pi\'s own config-directory override', () => {
    expect(stateDir({ PI_CODING_AGENT_DIR: '/opt/pi' } as NodeJS.ProcessEnv)).toBe(
      '/opt/pi/channels/prinny'
    );
  });

  it('agrees with the sidecar, which computes the same path independently', async () => {
    // The rule is written out in two places — here and in server/src/state.ts —
    // because the sidecar's sources are compiled into a directory outside the
    // repo and cannot be imported from an extension without dragging
    // node_modules along. Two copies of a rule is a bug waiting for a quiet
    // afternoon, so the copies are compared against each other rather than
    // trusted to stay in step.
    const probe = mkdtempSync(join(tmpdir(), 'prinny-agree-'));
    const previous = process.env.PRINNY_STATE_DIR;
    try {
      process.env.PRINNY_STATE_DIR = probe;
      vi.resetModules();
      const sidecar = await loadServerModule<{ STATE_DIR: string; ACCESS_FILE: string }>('state');
      expect(sidecar.STATE_DIR).toBe(stateDir(process.env));
      expect(sidecar.ACCESS_FILE).toBe(join(probe, 'access.json'));
    } finally {
      if (previous === undefined) delete process.env.PRINNY_STATE_DIR;
      else process.env.PRINNY_STATE_DIR = previous;
      rmSync(probe, { recursive: true, force: true });
    }
  });

  it('agrees with the sidecar on the default location too', async () => {
    // The override path above would pass even if the two defaults had drifted,
    // since PRINNY_STATE_DIR short-circuits both. This is the case that
    // actually exercises the shared rule.
    const previous = process.env.PRINNY_STATE_DIR;
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const agentDir = mkdtempSync(join(tmpdir(), 'prinny-agent-'));
    try {
      delete process.env.PRINNY_STATE_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      vi.resetModules();
      const sidecar = await loadServerModule<{ STATE_DIR: string }>('state');
      expect(sidecar.STATE_DIR).toBe(join(agentDir, 'channels', 'prinny'));
      expect(sidecar.STATE_DIR).toBe(stateDir(process.env));
    } finally {
      if (previous !== undefined) process.env.PRINNY_STATE_DIR = previous;
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
