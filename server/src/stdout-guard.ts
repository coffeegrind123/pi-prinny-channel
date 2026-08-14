/**
 * Keep fd 1 clean for the MCP transport.
 *
 * stdout **is** the JSON-RPC stream. One stray line on it and the client fails
 * with a parse error that names nothing useful, and the channel is simply dead.
 *
 * This is not hypothetical: matrix-js-sdk logs through `logger.debug`, whose
 * default backend writes to stdout, and `initRustCrypto` emits "Downloading
 * Rust crypto library" on the way up. That one line corrupted the stream on
 * every start. Any other library doing the same would too, so the fix is a
 * guard rather than a patch to one caller.
 *
 * The mechanism: take a private handle on fd 1 for the transport, then point
 * `process.stdout.write` and the console at stderr. Everything that thinks it
 * is printing to the terminal lands in the plugin log, where it is useful, and
 * only the transport can reach the wire.
 *
 * **Import this before anything else.** ES modules evaluate in import order,
 * and a library that logs while loading has already done the damage by the
 * time a later import could stop it.
 */

import { createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';

/** The real fd 1. Hand this to StdioServerTransport; write nothing else to it. */
export const mcpStdout: Writable = createWriteStream('', {
  fd: 1,
  // Closing fd 1 out from under the process would be a strange way to end.
  autoClose: false,
});

const realStdoutWrite = process.stdout.write.bind(process.stdout);

/** Was anything diverted? Useful when explaining a silent library to a user. */
let diverted = 0;

process.stdout.write = ((
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void
): boolean => {
  diverted += 1;
  if (typeof encoding === 'function') return process.stderr.write(chunk, encoding);
  return process.stderr.write(chunk, encoding as BufferEncoding, callback);
}) as typeof process.stdout.write;

function toStderr(...args: unknown[]): void {
  // Counted here as well as in the stdout override: console.log goes straight
  // to stderr without passing through it, and a count that silently ignored
  // the commonest case would be worse than no count.
  diverted += 1;
  const line = args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
  process.stderr.write(`${line}\n`);
}

// console.error and console.warn already go to stderr, but they are replaced
// too so that a library swapping them for stdout cannot undo this.
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;
console.error = toStderr;
console.trace = toStderr;

/** How many writes were kept off the wire. Zero is the normal, boring case. */
export function divertedWrites(): number {
  return diverted;
}

/**
 * Escape hatch, for a caller that genuinely must reach the real stdout and is
 * not the transport. Nothing uses it today; it exists so that a future need
 * does not tempt someone into removing the guard.
 */
export function writeRawStdout(chunk: string): boolean {
  return realStdoutWrite(chunk);
}
