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
 * lines. No model is needed: pi reports an injected message on arrival, in the
 * `queue_update` event if it is still busy, so the assertions hold whether or
 * not a backend is up.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { after, before, describe, expect, it } from './harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const EXTENSION = join(PACKAGE_ROOT, 'extensions', 'index.ts');
const FAKE_SIDECAR = join(HERE, 'fixtures', 'fake-sidecar.mjs');

let stateDir: string;
let events: Array<Record<string, unknown>> = [];
let channelLog = '';

/** Long enough for pi to boot, hand shake, and take the injected turn. */
const RUN_MS = 12_000;

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

  const stdout = await new Promise<string>((resolve) => {
    const proc = spawn(
      'pi',
      ['-e', EXTENSION, '--mode', 'json', 'this prompt is never answered — no backend is running'],
      {
        cwd: PACKAGE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PRINNY_STATE_DIR: stateDir,
          PRINNY_SIDECAR_ENTRY: FAKE_SIDECAR,
        },
      }
    );
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    // pi retries a dead provider indefinitely, which is correct behaviour and
    // not what is being tested. Give it a fixed window and take what arrived.
    const timer = setTimeout(() => proc.kill('SIGKILL'), RUN_MS);
    proc.on('exit', () => {
      clearTimeout(timer);
      resolve(out);
    });
    proc.on('error', () => {
      clearTimeout(timer);
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

after(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
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
    const injected = piInputs().find((text) => text.includes('hello from matrix'));
    expect(typeof injected).toBe('string');
    expect(injected).toContain('<channel ');
    expect(injected).toContain('source="prinny"');
    expect(injected).toContain('room_id="!room:example.org"');
    expect(injected).toContain('message_id="$evt1"');
    expect(injected).toContain('</channel>');
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
