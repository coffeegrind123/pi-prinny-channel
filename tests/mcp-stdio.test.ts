/**
 * The MCP client, driven against a real child process.
 *
 * Not against a mock: the failures this layer exists to survive are all about
 * what arrives on a pipe — a message split across two chunks, a library writing
 * a line of prose onto the transport, a child that dies mid-request. A mock
 * that hands over whole well-formed messages would pass every one of these
 * while the real thing fell over.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from './harness.ts';
import { McpChild, resultText } from '../src/mcp-stdio.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-sidecar.mjs');

let live: McpChild[] = [];

function connect(
  mode = 'normal',
  overrides: Partial<ConstructorParameters<typeof McpChild>[0]> = {}
): { child: McpChild; notifications: Array<{ method: string; params: Record<string, unknown> }>; stderr: string[] } {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const stderr: string[] = [];
  const child = new McpChild({
    command: process.execPath,
    args: [FAKE],
    env: { PRINNY_FAKE_MODE: mode },
    onStderr: (line) => stderr.push(line),
    onExit: () => undefined,
    onNotification: (method, params) => notifications.push({ method, params }),
    // Generous, and deliberately so. `node --test` runs the files in parallel,
    // so a dozen node processes can be spawning at the moment one of these
    // handshakes starts; a tight budget here fails as "initialize timed out",
    // which reads as a protocol bug rather than as a busy machine. The cases
    // that are actually *about* a timeout set their own short one.
    connectTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
    clientName: 'test',
    clientVersion: '0.0.0',
    ...overrides,
  });
  live.push(child);
  return { child, notifications, stderr };
}

afterEach(async () => {
  for (const child of live) await child.stop(500).catch(() => undefined);
  live = [];
});

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe('handshake', () => {
  it('completes initialize and reports the sidecar is running', async () => {
    const { child } = connect();
    await child.start();
    expect(child.running).toBe(true);
    expect(child.handshakeComplete).toBe(true);
  });

  it('fails with a timeout rather than hanging when initialize is never answered', async () => {
    const { child } = connect('nohandshake', { connectTimeoutMs: 300 });
    let message = '';
    try {
      await child.start();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('initialize timed out');
  });

  it('refuses to start twice, rather than leaking a second poller', async () => {
    const { child } = connect();
    await child.start();
    let message = '';
    try {
      await child.start();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('already started');
  });
});

describe('tool calls', () => {
  it('round-trips arguments and returns the text content', async () => {
    const { child } = connect();
    await child.start();
    const result = await child.callTool('reply', { room_id: '!r:x', text: 'hi' });
    expect(resultText(result)).toBe('reply:{"room_id":"!r:x","text":"hi"}');
    expect(result.isError).toBeUndefined();
  });

  it('surfaces a JSON-RPC error as a rejection naming the method', async () => {
    const { child } = connect();
    await child.start();
    let message = '';
    try {
      await child.callTool('boom', {});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('tools/call');
    expect(message).toContain('boom failed on purpose');
  });

  it('passes isError through instead of throwing, so the caller decides', async () => {
    const { child } = connect();
    await child.start();
    const result = await child.callTool('refuse', {});
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('not allowlisted');
  });

  it('times out a call the sidecar never answers', async () => {
    const { child } = connect('silent', { requestTimeoutMs: 200 });
    await child.start();
    let message = '';
    try {
      await child.callTool('reply', {});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('timed out');
  });

  it('lists the sidecar tools', async () => {
    const { child } = connect();
    await child.start();
    const tools = await child.listTools();
    expect(tools).toContain('reply');
    expect(tools).toContain('fetch_messages');
    expect(tools).toHaveLength(6);
  });

  it('rejects a call once the channel has been stopped', async () => {
    const { child } = connect();
    await child.start();
    await child.stop(500);
    let message = '';
    try {
      await child.callTool('reply', {});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('not running');
  });
});

describe('framing', () => {
  it('reassembles a message split across chunk boundaries', async () => {
    const { child } = connect('split');
    await child.start();
    const result = await child.callTool('reply', { room_id: '!r:x', text: 'split me' });
    expect(resultText(result)).toContain('split me');
  });

  it('survives a non-JSON line on the transport and still answers the call', async () => {
    const { child, stderr } = connect('noisy');
    await child.start();
    const result = await child.callTool('reply', { text: 'still here' });
    expect(resultText(result)).toContain('still here');
    // The raw line is logged, not a verdict about it — that is what makes a
    // stray library write diagnosable rather than merely reported.
    expect(stderr.join('')).toContain('Downloading Rust crypto library');
  });
});

describe('notifications', () => {
  it('delivers the channel notification the sidecar sends after initialized', async () => {
    const { child, notifications } = connect();
    await child.start();
    await settle();
    const inbound = notifications.find((n) => n.method === 'notifications/claude/channel');
    expect(inbound).toMatchObject({
      method: 'notifications/claude/channel',
      params: { content: 'hello from matrix' },
    });
  });

  it('round-trips a permission request and its decision', async () => {
    const { child, notifications } = connect();
    await child.start();
    child.notify('notifications/claude/channel/permission_request', {
      request_id: 'abcde',
      tool_name: 'bash',
      description: 'rm -rf /',
      input_preview: '{}',
    });
    await settle();
    const decision = notifications.find(
      (n) => n.method === 'notifications/claude/channel/permission'
    );
    expect(decision?.params).toMatchObject({ request_id: 'abcde', behavior: 'allow' });
  });

  it('carries a denial back just as faithfully as an approval', async () => {
    const { child, notifications } = connect();
    await child.start();
    child.notify('notifications/claude/channel/permission_request', {
      request_id: 'bcdef',
      tool_name: 'deny_me',
      description: 'nope',
      input_preview: '{}',
    });
    await settle();
    const decision = notifications.find(
      (n) => n.method === 'notifications/claude/channel/permission'
    );
    expect(decision?.params).toMatchObject({ behavior: 'deny' });
  });
});

describe('child death', () => {
  it('fails in-flight and later calls when the child exits', async () => {
    const exits: Array<number | null> = [];
    const { child } = connect('crash', { onExit: (code) => exits.push(code) });
    await child.start();
    await settle(200);
    expect(exits).toContain(3);
    let message = '';
    try {
      await child.callTool('reply', {});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('not running');
  });
});

/**
 * AK3 — a request from the sidecar is not a reply to ours.
 *
 * JSON-RPC gives a server-initiated REQUEST both an `id` and a `method`.
 * `dispatch` used to branch on `typeof id === 'number'` first, so such a
 * message was matched against `pending` and, on a hit,
 * `pending.resolve(message.result)` — with `message.result` undefined. The
 * client's own outstanding call therefore resolved with nothing, no error, and
 * no sign anything had gone wrong.
 *
 * `nextId` starts at 1 and `initialize` is the first thing this client sends,
 * so the first server request in a fresh process would have resolved the
 * HANDSHAKE: `start()` returns, `handshakeComplete` is true, and the channel
 * reads as up while the sidecar never answered.
 *
 * The `method not found` reply below is not new — it was written for exactly
 * this case, and its own comment says "a server-initiated *request* (has an
 * id)". It was unreachable for a numeric id, which is the only kind anything
 * sends. Reordering the two branches is the whole fix.
 */
describe('a server-initiated request (AK3)', () => {
  it('is answered, and does not resolve the call it collides with', async () => {
    const { child, stderr } = connect('serverrequest', { requestTimeoutMs: 1_500 });
    await child.start();

    let resolved: unknown;
    let rejected: Error | undefined;
    await child
      .callTool('reply', { text: 'anything' })
      .then((value) => {
        resolved = value;
      })
      .catch((err: Error) => {
        rejected = err;
      });

    // BEFORE: resolved with `{ content: [] }` the moment the request arrived —
    // an empty success for a call the sidecar never ran.
    expect(resolved).toBeUndefined();
    expect(rejected?.message).toContain('tools/call timed out');

    // …and the request itself got the answer the code always meant to send.
    await settle();
    const reply = stderr.join('');
    expect(reply).toContain('client-reply');
    expect(reply).toContain('-32601');
    expect(reply).toContain('method not found: ping');
  });

  it('still dispatches an ordinary notification, which has no id at all', async () => {
    const { child, notifications } = connect();
    await child.start();
    await settle();
    expect(notifications.some((n) => n.method === 'notifications/claude/channel')).toBe(true);
  });
});

/**
 * A reply whose id is a STRING, and a reply whose id is nobody's.
 *
 * JSON-RPC 2.0 allows a string, a number or null for `id`, and asks a server
 * for one thing: echo back what it was sent. This client only ever sends
 * numbers, so `typeof id === 'number'` covered every reply the sidecar in this
 * repo has ever produced — and covered nothing else. A server that stringifies
 * its ids on the way out answered `7` as `"7"`, the reply matched neither the
 * `method` branch nor the id branch, and `dispatch` returned having done
 * nothing at all. No log line, no rejection: the promise simply sat there until
 * `requestTimeoutMs`, and the symptom was "the sidecar never answered" — which
 * points the investigation at the sidecar rather than at the wire.
 *
 * `stringid` stringifies EVERY id including the handshake's, so the first
 * assertion below is that `start()` itself survives. The old code would not
 * have reached the second.
 */
describe('a reply whose id is not the number we sent', () => {
  it('completes the handshake and the call when the sidecar stringifies ids', async () => {
    const { child, stderr } = connect('stringid', { requestTimeoutMs: 4_000 });
    await child.start();
    expect(child.running).toBe(true);

    const result = await child.callTool('reply', { text: 'hello' });
    expect(resultText(result)).toContain('reply:');

    // Handled is not the same as unremarkable: a server doing this is out of
    // step with what we sent, and it is reported once so it is knowable.
    const notes = stderr.join('');
    expect(notes).toContain('echoes JSON-RPC ids as strings');
  });

  it('reports the string-id mismatch once, not once per call', async () => {
    const { child, stderr } = connect('stringid', { requestTimeoutMs: 4_000 });
    await child.start();
    await child.callTool('reply', { text: 'one' });
    await child.callTool('reply', { text: 'two' });
    const occurrences = stderr.join('').split('echoes JSON-RPC ids as strings').length - 1;
    expect(occurrences).toBe(1);
  });

  it('reports a reply it has no home for instead of dropping it', async () => {
    // The reason the string coercion is conditional, and the reason the two
    // dead ends now say so. `unknownid` answers with a perfectly well-formed
    // reply carrying id 999999 - which nobody issued - and an `id: null` error.
    const { child, stderr } = connect('unknownid', { requestTimeoutMs: 1_200 });
    await child.start();

    let rejected: Error | undefined;
    await child.callTool('reply', { text: 'anything' }).catch((err: Error) => {
      rejected = err;
    });
    expect(rejected?.message).toContain('tools/call timed out');

    // BEFORE: both dropped without trace, on two different branches. The lines
    // themselves are the evidence; neither claims to know WHY the id is
    // unmatched, because that is the part most likely to be wrong.
    await settle();
    const notes = stderr.join('');
    expect(notes).toContain('reply for request id 999999, which is not outstanding');
    expect(notes).toContain('unrecognised message on the channel transport');
    expect(notes).toContain('parse error');
  });
});
