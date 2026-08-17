/**
 * The extension, inside a real pi process, driven by a stand-in sidecar.
 *
 * Everything else in this directory tests a function. This tests the wiring:
 * that the notification method string is the one the sidecar actually sends,
 * that the payload shape is the one `renderChannelBlock` expects, and that the
 * result reaches pi rather than disappearing.
 *
 * Every one of those fails *silently* when it is wrong — the channel comes up,
 * the log looks healthy, and messages simply never arrive. That is not a class
 * of bug worth trusting to a reading of the code.
 *
 * pi is spawned in `--mode json`, where the session emits its events as JSON
 * lines, against a stub model on loopback and its own agent directory — so the
 * run is the same on a developer box with a local GPU and on a CI runner with
 * no provider at all. It used to be spawned with whatever provider the machine
 * happened to have; with none, pi emitted `{"type":"session"}` and stopped, and
 * the delivery assertion failed for a reason that had nothing to do with the
 * channel.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

let stateDir: string;
let piDir: string;
let stubModel: { baseUrl: string; close: () => Promise<void> } | undefined;
let events: Array<Record<string, unknown>> = [];
let channelLog = '';

/**
 * The run stops on the thing being measured, not on a stopwatch.
 *
 * It used to wait a flat 12s and SIGKILL. That was a race dressed as a test: pi
 * boots, retries a dead provider with backoff, THEN the sidecar hands shake and
 * the message is injected, and if any of that lands after the deadline the
 * SIGKILL takes the unflushed stdout with it — so the failure is an empty event
 * list and `expected "undefined" to be "string"`, which names neither the
 * delivery nor the clock. Measured 2026-08-16: the same run needs ~30s here and
 * passes every assertion at 45s.
 *
 * So: watch stdout for the delivery, stop as soon as it arrives, and keep a
 * ceiling only as a backstop. Fast when it works, and when it does not, the
 * ceiling is the only thing that was ever in question.
 */
const CEILING_MS = 75_000;  // the node test timeout is 90s; leave room to flush

/** The injected text the run is waiting for — see the fake sidecar's payload. */
const DELIVERY_MARKER = 'hello from matrix';

/** SIGTERM first: pi buffers stdout when it is a pipe, and SIGKILL loses it. */
const FLUSH_GRACE_MS = 3_000;

/**
 * `pi` has to be on PATH for this to mean anything.
 *
 * Reported rather than skipped: an extension test suite that quietly passes on
 * a machine with no pi is worse than one that fails, because the thing it was
 * protecting is exactly the pi integration.
 */
function requirePi(): void {
  const probe = spawnSync('pi', ['--version'], { stdio: 'ignore' });
  if (probe.error) {
    throw new Error(
      'pi is not on PATH, so the extension cannot be tested inside it. ' +
        'Install pi, or run the other suites individually.'
    );
  }
}

before(async () => {
  requirePi();
  stateDir = mkdtempSync(join(tmpdir(), 'prinny-e2e-'));

  // The extension refuses to spawn anything until both of these exist, which is
  // deliberate: an unconfigured sidecar exits immediately and an unbuilt one
  // blocks for a minute installing, and both present as "the bot ignores me".
  // The fake needs neither, so they are satisfied rather than bypassed — the
  // check itself is part of what is under test.
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

  // Its own agent directory, so the run does not inherit the developer's
  // providers, packages or settings — any of which change what pi does here.
  stubModel = await startStubModel();
  piDir = mkdtempSync(join(tmpdir(), 'prinny-e2e-pi-'));
  writeFileSync(
    join(piDir, 'models.json'),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl: stubModel!.baseUrl,
          api: 'openai-completions',
          // pi hides models it considers unauthenticated, so a keyless local
          // server still needs a placeholder.
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

  const stdout = await new Promise<string>((resolve) => {
    const proc = spawn(
      'pi',
      [
        '-e',
        EXTENSION,
        '--provider',
        'stub',
        '--model',
        'stub-1',
        '-nc',
        '--mode',
        'json',
        'a prompt for the stub model',
      ],
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
    let out = '';
    let ceiling: ReturnType<typeof setTimeout>;
    let hardKill: ReturnType<typeof setTimeout> | undefined;

    // pi retries a dead provider indefinitely, which is correct behaviour and
    // not what is being tested. Ask it to stop once the delivery has landed;
    // SIGTERM rather than SIGKILL so buffered stdout is flushed on the way out.
    const stop = (): void => {
      clearTimeout(ceiling);
      proc.kill('SIGTERM');
      hardKill ??= setTimeout(() => proc.kill('SIGKILL'), FLUSH_GRACE_MS);
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (out.includes(DELIVERY_MARKER)) stop();
    });

    ceiling = setTimeout(stop, CEILING_MS);
    proc.on('exit', () => {
      clearTimeout(ceiling);
      if (hardKill) clearTimeout(hardKill);
      resolve(out);
    });
    proc.on('error', () => {
      clearTimeout(ceiling);
      if (hardKill) clearTimeout(hardKill);
      resolve(out);
    });
  });

  events = stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

  try {
    channelLog = readFileSync(join(stateDir, 'channel.log'), 'utf8');
  } catch {
    channelLog = '';
  }
});

after(async () => {
  await stubModel?.close();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  if (piDir) rmSync(piDir, { recursive: true, force: true });
});

/**
 * Everything that reached pi as input — delivered or queued.
 *
 * Both count, and the queue is not a lesser outcome. Inbound messages are sent
 * with `deliverAs: "followUp"` so they join the queue rather than interrupting
 * whatever the operator asked for in the terminal; with no backend running, pi
 * spends this whole test retrying its first turn, so the queue is exactly where
 * a correctly-delivered message sits. Asserting only on `message_start` would
 * have failed for the one reason that is not a bug.
 */
function piInputs(): string[] {
  const inputs: string[] = [];

  for (const event of events) {
    if (event.type === 'message_start') {
      const message = event.message as { role?: string; content?: unknown } | undefined;
      if (message?.role !== 'user') continue;
      const content = message.content;
      if (typeof content === 'string') inputs.push(content);
      else if (Array.isArray(content)) {
        inputs.push(content.map((part) => (part as { text?: string }).text ?? '').join(''));
      }
      continue;
    }
    if (event.type === 'queue_update') {
      for (const key of ['steering', 'followUp'] as const) {
        const queued = event[key];
        if (Array.isArray(queued)) inputs.push(...queued.map((entry) => String(entry)));
      }
    }
  }

  return inputs;
}

describe('extension end to end', () => {
  it('starts the sidecar and completes the handshake', () => {
    expect(channelLog).toContain('sidecar handshake complete');
  });

  it('turns an inbound Matrix message into pi input', () => {
    const injected = piInputs().find((text) => text.includes(DELIVERY_MARKER));
    // Said here rather than as "expected undefined to be string", which names
    // neither what was delivered nor how far the run got. The two failures worth
    // telling apart are "the sidecar never handed shake" (empty channel log) and
    // "pi produced nothing before the ceiling" (no event types).
    if (injected === undefined) {
      const types = [...new Set(events.map((event) => String(event.type)))].join(', ') || '(none)';
      throw new Error(
        `no pi input contained ${JSON.stringify(DELIVERY_MARKER)}.\n` +
          `pi event types seen: ${types}\n` +
          `pi inputs seen: ${JSON.stringify(piInputs())}\n` +
          `channel log:\n${channelLog.trim() || '(empty)'}`
      );
    }
    expect(typeof injected).toBe('string');
    // The marker, and the message. The routing identifiers that used to ride
    // along on every message are held by the extension now, so their ABSENCE is
    // the assertion — if they come back, the per-message cost came back with
    // them.
    expect(injected).toContain('[matrix]');
    expect(injected).toContain(DELIVERY_MARKER);
    expect(injected).not.toContain('<channel ');
    expect(injected).not.toContain('room_id=');
    expect(injected).not.toContain('message_id=');
    expect(injected).not.toContain('$evt1');
  });

  it('records the delivery in the channel log, not on the terminal', () => {
    // The log is the whole reporting channel: pi owns stdout and stderr, and a
    // line written to either scribbles over the TUI.
    expect(channelLog).toContain('inbound from @bob:example.org');
  });

  it('keeps the sidecar\'s stderr off pi\'s event stream', () => {
    const raw = JSON.stringify(events);
    expect(raw).not.toContain('fake sidecar ready');
    expect(channelLog).toContain('fake sidecar ready');
  });

  it('does not forward the alias room id, so there is one room to answer', () => {
    const injected = piInputs().find((text) => text.includes('hello from matrix')) ?? '';
    expect(injected).not.toContain('chat_id');
  });
});
