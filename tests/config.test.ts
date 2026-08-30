/**
 * Settings, and the one rule this file duplicates from the sidecar.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      expect(outcome.error).toContain('off | result | last | all');
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

  /**
   * AO7 — the override is a path, and `~/pi-work` is a path a person writes.
   *
   * All four readers of `PI_CODING_AGENT_DIR` in this package used
   * `env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')`; pi's own
   * `getAgentDir()` runs the value through `expandTildePath` first. A value read
   * out of the channel's `.env` is not expanded by any shell, so pi kept its
   * files in `$HOME/pi-work` and this package kept the allowlist, the
   * credentials and the crypto store in a directory literally named `~`,
   * relative to whatever the cwd was.
   */
  it('expands a leading tilde, because pi does', () => {
    const home = homedir();
    expect(stateDir({ PI_CODING_AGENT_DIR: '~/pi-work' } as NodeJS.ProcessEnv)).toBe(
      join(home, 'pi-work', 'channels', 'prinny')
    );
    expect(stateDir({ PI_CODING_AGENT_DIR: '~' } as NodeJS.ProcessEnv)).toBe(
      join(home, 'channels', 'prinny')
    );
  });

  it('does not expand a tilde that is not a home reference', () => {
    expect(stateDir({ PI_CODING_AGENT_DIR: '/tmp/~backup' } as NodeJS.ProcessEnv)).toBe(
      '/tmp/~backup/channels/prinny'
    );
  });

  it('the tilde rule is pi\'s own, read out of the install rather than remembered', () => {
    const PATHS = '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js';
    if (!existsSync(PATHS)) return;
    const source = readFileSync(PATHS, 'utf8');
    expect(source).toContain('if (normalized === "~")');
    expect(source).toContain('normalized.startsWith("~/")');
  });

  it('nobody else in this package builds the agent directory itself', () => {
    // The scan, not the fifth fix. Two files may hold the rule: the shared
    // helper, and `server/src/state.ts`, which cannot import it because it is
    // compiled with `rootDir: src` into a runtime outside the repo.
    const ALLOWED = new Set(['server/bin/agent-dir.mjs', 'server/src/state.ts']);
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // `tests/` is skipped: a test that names the variable is asking about
        // it, not resolving it.
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|mjs)$/.test(entry.name)) continue;
        const name = relative(root, full).replaceAll('\\', '/');
        if (ALLOWED.has(name)) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (code.includes('PI_CODING_AGENT_DIR')) offenders.push(name);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('the two packages answer the same question the same way', async () => {
    // `vendor/pi-subagents-lite/src/agent-dir.ts` is the other copy of this
    // rule. Vendor packages here do not import each other, so the copies are
    // compared — the arrangement the compaction lock and json-store already use.
    const { agentDir: theirs } = await import(
      '../../pi-subagents-lite/src/agent-dir.ts'
    );
    const { agentDir: ours } = await import('../server/bin/agent-dir.mjs');
    for (const value of ['~/pi-work', '~', '/opt/pi', '/tmp/~backup', '', 'relative/dir']) {
      const env = value === '' ? {} : { PI_CODING_AGENT_DIR: value };
      expect(ours(env)).toBe(theirs(env));
    }
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
