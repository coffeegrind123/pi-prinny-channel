#!/usr/bin/env node
/**
 * A stand-in for the channel sidecar, for testing `McpChild` against something
 * that speaks the wire rather than against a mock of it.
 *
 * The real sidecar needs Matrix credentials, a homeserver and ~105MB of
 * dependencies. What the client actually has to get right is framing, request
 * correlation and notification dispatch — none of which involve Matrix. This
 * answers the same protocol and can be told to misbehave in the specific ways
 * the client claims to survive.
 *
 * Behaviour is chosen by PRINNY_FAKE_MODE:
 *   normal      handshake, tools, and a notification after `notifications/initialized`
 *   split       writes every message in two chunks, splitting mid-JSON
 *   noisy       emits a non-JSON line before answering, as a chatty library would
 *   silent      completes the handshake and never answers a tool call
 *   nohandshake never answers `initialize`
 *   crash       exits as soon as it is initialized
 *   serverrequest
 *               answers a tools/call with a server-initiated REQUEST carrying
 *               the SAME id, which is exactly what a JSON-RPC server does when
 *               it asks the client something (ping, roots/list,
 *               sampling/createMessage) while a call is outstanding. Whatever
 *               the client sends back is echoed to stderr so a test can read
 *               it. See AK3.
 */

const MODE = process.env.PRINNY_FAKE_MODE ?? 'normal';

let buffer = '';

function send(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (MODE === 'split' && line.length > 8) {
    const cut = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, cut));
    // A real chunk boundary is a scheduling accident, so make it one.
    setTimeout(() => process.stdout.write(line.slice(cut)), 5);
    return;
  }
  process.stdout.write(line);
}

function handle(message) {
  const { id, method, params } = message;

  // A reply from the CLIENT — it has an id and no method. The only one this
  // fixture ever provokes is the answer to the server request `serverrequest`
  // mode sends, so put it where a test can read it.
  if (method === undefined && id !== undefined) {
    process.stderr.write(`client-reply ${JSON.stringify(message)}\n`);
    return;
  }

  if (method === 'initialize') {
    if (MODE === 'nohandshake') return;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'fake-prinny', version: '0.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    if (MODE === 'crash') process.exit(3);
    // The real sidecar starts delivering once the client acknowledges. Do the
    // same, so the client's notification path is exercised unprompted.
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: {
          content: 'hello from matrix',
          meta: {
            room_id: '!room:example.org',
            chat_id: '!room:example.org',
            message_id: '$evt1',
            user: 'Bob',
            user_id: '@bob:example.org',
            ts: '2026-08-14T00:00:00.000Z',
            is_direct: 'true',
          },
        },
      });
    }, 10);
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'reply' },
          { name: 'react' },
          { name: 'edit_message' },
          { name: 'download_attachment' },
          { name: 'fetch_messages' },
          { name: 'search' },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    if (MODE === 'silent') return;
    if (MODE === 'serverrequest') {
      // Not a reply — a REQUEST, wearing the id the client is waiting on.
      send({ jsonrpc: '2.0', id, method: 'ping', params: {} });
      return;
    }
    if (MODE === 'noisy') {
      // Exactly the failure the sidecar's stdout guard exists to prevent.
      process.stdout.write('Downloading Rust crypto library\n');
    }
    const name = params?.name;
    if (name === 'boom') {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'boom failed on purpose' } });
      return;
    }
    if (name === 'refuse') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'room not allowlisted' }], isError: true },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `${name}:${JSON.stringify(params?.arguments ?? {})}` }],
      },
    });
    return;
  }

  if (method === 'notifications/claude/channel/permission_request') {
    // Echo a decision back, driven by the tool name so a test can ask for either.
    const behavior = params?.tool_name === 'deny_me' ? 'deny' : 'allow';
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel/permission',
        params: { request_id: params?.request_id, behavior },
      });
    }, 5);
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch (err) {
        process.stderr.write(`fake sidecar could not parse: ${line} (${err})\n`);
      }
    }
    index = buffer.indexOf('\n');
  }
});

// The real sidecar treats a closed stdin as its shutdown signal.
process.stdin.on('end', () => process.exit(0));
process.stderr.write('fake sidecar ready\n');
