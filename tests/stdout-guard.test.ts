import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, loadServerModule, RUNTIME_DIST } from './harness.ts';

/**
 * The guard mutates process-wide state at import, so it is exercised in a real
 * subprocess with the two streams captured separately. Anything less would not
 * be testing the thing that actually broke: a library writing to fd 1.
 */
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'prinny-guard-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runWithGuard(body: string): { stdout: string; stderr: string } {
  const guard = join(RUNTIME_DIST, 'stdout-guard.js');
  const script = join(workDir, 'probe.mjs');
  writeFileSync(
    script,
    `import { mcpStdout, divertedWrites } from ${JSON.stringify(guard)}\n${body}\n`
  );
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('stdout guard', () => {
  it('diverts console.log away from the MCP stream', () => {
    const { stdout, stderr } = runWithGuard(`console.log('chatty library')`);
    expect(stdout).toBe('');
    expect(stderr).toContain('chatty library');
  });

  it('diverts a direct process.stdout.write', () => {
    const { stdout, stderr } = runWithGuard(`process.stdout.write('raw bytes\\n')`);
    expect(stdout).toBe('');
    expect(stderr).toContain('raw bytes');
  });

  it('diverts every console channel a library might reach for', () => {
    const { stdout, stderr } = runWithGuard(
      `console.info('i'); console.debug('d'); console.warn('w'); console.error('e')`
    );
    expect(stdout).toBe('');
    for (const marker of ['i', 'd', 'w', 'e']) expect(stderr).toContain(marker);
  });

  it('still lets the transport handle reach the real stdout', () => {
    const { stdout, stderr } = runWithGuard(
      `mcpStdout.write('{"jsonrpc":"2.0"}\\n'); await new Promise(r => setTimeout(r, 50))`
    );
    expect(stdout.trim()).toBe('{"jsonrpc":"2.0"}');
    expect(stderr).toBe('');
  });

  it('keeps the wire clean even when a library logs around a transport write', () => {
    const { stdout } = runWithGuard(
      `console.log('Downloading Rust crypto library')\n` +
        `mcpStdout.write('{"id":1}\\n')\n` +
        `console.log('done')\n` +
        `await new Promise(r => setTimeout(r, 50))`
    );
    // Every line on fd 1 must parse, which is the actual contract.
    const lines = stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it('counts what it diverted, so the log can explain a quiet library', () => {
    const { stderr } = runWithGuard(
      `console.log('one'); console.log('two'); process.stderr.write('COUNT=' + divertedWrites() + '\\n')`
    );
    expect(stderr).toContain('COUNT=2');
  });

  it('reports zero when nothing misbehaved', () => {
    const { stderr } = runWithGuard(`process.stderr.write('COUNT=' + divertedWrites() + '\\n')`);
    expect(stderr).toContain('COUNT=0');
  });
});
