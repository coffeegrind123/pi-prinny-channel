/**
 * A stand-in OpenAI-compatible model, so the e2e test does not need a backend.
 *
 * The suite used to assume pi would queue an injected message while it retried
 * a dead provider, and read the injection out of the resulting `queue_update`.
 * On a machine with no provider configured at all — a CI runner — pi never gets
 * that far: it emits `{"type":"session"}` and stops, so nothing is ever queued
 * and the delivery assertion fails for a reason that has nothing to do with the
 * channel. Measured 2026-08-16 from CI's own output: `pi event types seen:
 * session`.
 *
 * A stub answers that properly. pi runs a real turn, the injected message is
 * either queued or taken as the next turn, and the assertion sees it either way
 * — on any machine, with no network, no key and no GPU.
 *
 * It answers one fixed word. Nothing here tests the model.
 *
 * The FIRST answer is held back deliberately. An instant model reverses the race
 * the old test lost: pi finishes its turn and exits before the sidecar's
 * handshake and delivery land, and the assertion fails with a channel log that
 * stops at the handshake. Holding the first turn open keeps pi streaming while
 * the message arrives, which is also the path the channel actually cares about —
 * a mid-turn arrival joins the follow-up queue rather than interrupting. Later
 * answers are immediate, so the queued message drains and pi exits promptly.
 */

import { createServer } from 'node:http';

/** Comfortably longer than the fake sidecar's 10ms post-handshake delivery. */
const FIRST_ANSWER_DELAY_MS = 3_000;

const TEXT = 'ok';

function answer(body, res) {
  let wantsStream = true;
  try {
    wantsStream = JSON.parse(body || '{}').stream !== false;
  } catch {
    // A body we cannot parse is still a completion request; answer it.
  }

  if (!wantsStream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 0,
        model: 'stub-1',
        choices: [
          { index: 0, message: { role: 'assistant', content: TEXT }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
    return;
  }

  // pi asks for a stream, and a non-streamed body reads to it as
  // "Stream ended without finish_reason".
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const chunk = (delta, finish = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'stub-1',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    );
  chunk({ role: 'assistant' });
  chunk({ content: TEXT });
  chunk({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Starts the stub on an ephemeral port. Resolves once it is listening. */
export function startStubModel() {
  let answered = 0;

  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-1', object: 'model' }] }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const delay = answered++ === 0 ? FIRST_ANSWER_DELAY_MS : 0;
      setTimeout(() => answer(body, res), delay);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
