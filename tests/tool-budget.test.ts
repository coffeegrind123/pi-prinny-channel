/**
 * What this extension costs a session that is not using it.
 *
 * Tool schemas are part of the request prefix on EVERY turn. Measured
 * 2026-08-16 by capturing what pi actually sent on a 32,768-token window: the
 * six `prinny_*` tools were 1,470 tokens — more than pi's own bash, read, edit
 * and write schemas combined (754), and 4.5% of the whole window, charged to
 * every turn forever including in sessions with no Matrix credentials at all.
 *
 * `isConfigured()` already gated the sidecar for exactly that reason, so an
 * unconfigured channel was paying for something that could not run. It now
 * gates registration too.
 *
 * This is asserted against the wire rather than against the source, because the
 * source cannot tell you what pi decided to send. The stand-in model records the
 * request; the assertion reads the `tools` array out of it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { after, before, describe, expect, it } from './harness.ts';
// @ts-expect-error — plain .mjs fixture, no types, deliberately dependency-free
import { startStubModel } from './fixtures/stub-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const EXTENSION = join(PACKAGE_ROOT, 'extensions', 'index.ts');
const FAKE_SIDECAR = join(HERE, 'fixtures', 'fake-sidecar.mjs');

/** One turn against a stub is quick; the ceiling only matters when it is not. */
const CEILING_MS = 60_000;
const FLUSH_GRACE_MS = 2_000;

interface Capture {
  tools: string[];
  toolChars: number;
}

let piDir: string;
let tempDirs: string[] = [];

function requirePi(): void {
  const probe = spawnSync('pi', ['--version'], { stdio: 'ignore' });
  if (probe.error) {
    throw new Error(
      'pi is not on PATH, so what the extension puts on the wire cannot be measured. ' +
        'Install pi, or run the other suites individually.'
    );
  }
}

/**
 * Run one pi turn with the extension loaded and report the tool surface it sent.
 *
 * `configured` writes the credentials `isConfigured()` looks for. Nothing else
 * differs between the two runs, so any difference in the tool list is the gate.
 */
async function toolsOnTheWire(configured: boolean): Promise<Capture> {
  const stateDir = mkdtempSync(join(tmpdir(), 'prinny-budget-'));
  tempDirs.push(stateDir);
  if (configured) {
    writeFileSync(
      join(stateDir, '.env'),
      [
        'PRINNY_HOMESERVER=https://matrix.invalid',
        'PRINNY_USER_ID=@pi:matrix.invalid',
        'PRINNY_PASSWORD=not-a-real-password',
      ].join('\n')
    );
    mkdirSync(join(stateDir, 'runtime', 'dist'), { recursive: true });
    writeFileSync(join(stateDir, 'runtime', 'dist', 'server.js'), '');
  }

  const stub = await startStubModel();
  try {
    writeFileSync(
      join(piDir, 'models.json'),
      JSON.stringify({
        providers: {
          stub: {
            baseUrl: stub.baseUrl,
            api: 'openai-completions',
            apiKey: 'local',
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [
              {
                id: 'stub-1',
                name: 'stub',
                contextWindow: 32768,
                maxTokens: 1024,
                input: ['text'],
                reasoning: false,
              },
            ],
          },
        },
      })
    );

    await new Promise<void>((resolve) => {
      const proc = spawn(
        'pi',
        ['-e', EXTENSION, '--provider', 'stub', '--model', 'stub-1', '-nc', '--mode', 'json', 'hi'],
        {
          cwd: PACKAGE_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: piDir,
            PRINNY_STATE_DIR: stateDir,
            PRINNY_SIDECAR_ENTRY: FAKE_SIDECAR,
          },
        }
      );
      let hardKill: ReturnType<typeof setTimeout> | undefined;
      const stop = (): void => {
        proc.kill('SIGTERM');
        hardKill ??= setTimeout(() => proc.kill('SIGKILL'), FLUSH_GRACE_MS);
      };
      // One captured request is all this measures; stop as soon as it lands.
      const poll = setInterval(() => {
        if (stub.requests.length > 0) stop();
      }, 250);
      const ceiling = setTimeout(stop, CEILING_MS);
      const done = (): void => {
        clearInterval(poll);
        clearTimeout(ceiling);
        if (hardKill) clearTimeout(hardKill);
        resolve();
      };
      proc.on('exit', done);
      proc.on('error', done);
    });

    const first = stub.requests[0] as { tools?: unknown[] } | undefined;
    const tools = (first?.tools ?? []) as { function?: { name?: string }; name?: string }[];
    return {
      tools: tools.map((tool) => tool.function?.name ?? tool.name ?? '<unnamed>'),
      toolChars: JSON.stringify(tools).length,
    };
  } finally {
    await stub.close();
  }
}

let unconfigured: Capture;
let configured: Capture;

before(async () => {
  requirePi();
  piDir = mkdtempSync(join(tmpdir(), 'prinny-budget-pi-'));
  tempDirs.push(piDir);
  unconfigured = await toolsOnTheWire(false);
  configured = await toolsOnTheWire(true);
});

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('tool budget', () => {
  it('sends the model something, so an empty capture cannot pass as a pass', () => {
    // The control. Without it, "no prinny tools" is satisfied by a run where pi
    // never reached the model at all — which is how this measurement fails.
    expect(configured.tools.length > 0).toBe(true);
    expect(unconfigured.tools.length > 0).toBe(true);
    // pi's own tools are there in both runs; only the channel's come and go.
    expect(unconfigured.tools).toContain('bash');
    expect(configured.tools).toContain('bash');
  });

  it('charges an unconfigured session nothing for a channel it cannot use', () => {
    const leaked = unconfigured.tools.filter((name) => name.startsWith('prinny_'));
    expect(leaked).toEqual([]);
  });

  it('still registers the channel tools once credentials exist', () => {
    const registered = configured.tools.filter((name) => name.startsWith('prinny_')).sort();
    expect(registered).toEqual([
      'prinny_download_attachment',
      'prinny_edit_message',
      'prinny_fetch_messages',
      'prinny_react',
      'prinny_reply',
      'prinny_search',
    ]);
  });

  it('measures the saving rather than asserting it exists in the abstract', () => {
    const saved = configured.toolChars - unconfigured.toolChars;
    // ~5,900 chars / ~1,470 tokens when this was written. Asserted loosely: the
    // point is that it is large, and editing a description should not fail an
    // unrelated suite.
    expect(saved > 3_000).toBe(true);
  });
});
