/**
 * A minimal MCP client over a child process's stdio.
 *
 * The channel sidecar (`server/src/server.ts`) speaks MCP because that is what
 * it spoke as a Claude Code plugin, and keeping its transport untouched is what
 * lets it still be diffed against upstream. This is the other half: enough of
 * the client side to drive it, and no more.
 *
 * **Why hand-rolled rather than `@modelcontextprotocol/sdk`.** The SDK is a
 * real dependency, and a dependency here means a `node_modules` tree under
 * `vendor/` — the one thing the sidecar's own bootstrap exists to avoid. pi
 * resolves an extension's bare imports against its own module root, which
 * carries `typebox` and pi's types but not the MCP SDK, so the SDK could only
 * be reached by deep-importing the staged runtime's copy by absolute path
 * (`.../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`) —
 * a path into another package's build output that no semver range protects.
 * The subset actually used here is four methods of a stable, versioned
 * protocol, so it is written out instead. Everything unused — resources,
 * prompts, sampling, progress, cancellation — is deliberately absent.
 *
 * Framing: MCP stdio is newline-delimited JSON-RPC 2.0, one message per line,
 * no embedded newlines. `Content-Length` framing belongs to LSP, not to this.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** JSON-RPC id counter. Never reused, so a late reply cannot land on a new call. */
let nextId = 1;

export type JsonRpcError = { code: number; message: string; data?: unknown };

export type ToolCallResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
};

/** What the sidecar sends us unprompted. */
export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

export type McpChildOptions = {
  command: string;
  args: string[];
  /** Extra environment for the child. Merged over `process.env`. */
  env?: Record<string, string>;
  cwd?: string;
  /** Where the child's stderr goes. One line per write, already newline-terminated. */
  onStderr: (line: string) => void;
  /** Called when the child exits, for any reason. */
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onNotification: NotificationHandler;
  /** How long `initialize` may take before the child is declared dead. */
  connectTimeoutMs: number;
  /** Default per-request timeout for `callTool`. */
  requestTimeoutMs: number;
  /** Client identity sent in `initialize`. */
  clientName: string;
  clientVersion: string;
};

/**
 * The protocol version we claim.
 *
 * The server side is `@modelcontextprotocol/sdk` ^1, which negotiates: it
 * answers with a version it supports, and does not refuse an older client. This
 * is pinned rather than tracked because nothing here uses a feature added after
 * it — when that changes, the change will be deliberate.
 */
const PROTOCOL_VERSION = '2024-11-05';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

export class McpChild {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  /** Partial line left over from the last stdout chunk. */
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;
  private initialized = false;
  /**
   * Assigned in the body rather than declared as a constructor parameter
   * property.
   *
   * `constructor(private readonly options: …)` is TypeScript that *emits code*,
   * and Node's strip-only type stripping refuses it outright with
   * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. pi's own loader happens to cope, so this
   * would have run under pi and failed only under `node --test` — the kind of
   * split where the tests are the thing that stops working and the fix looks
   * like a test problem.
   */
  private readonly options: McpChildOptions;

  constructor(options: McpChildOptions) {
    this.options = options;
  }

  get running(): boolean {
    return this.child !== null && !this.closed;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /**
   * Spawn the child and complete the MCP handshake.
   *
   * Resolves once `initialize` has been answered — at which point the sidecar
   * has its transport up but has not yet loaded matrix-js-sdk, which is exactly
   * the split the sidecar is built around.
   */
  async start(): Promise<void> {
    if (this.child) throw new Error('already started');

    const child = spawn(this.options.command, this.options.args, {
      // stdin/stdout are the transport. stderr is the channel log.
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      env: { ...process.env, ...(this.options.env ?? {}) },
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderrChunk(chunk));

    // A pipe whose reader has gone away raises EPIPE on the next write. Without
    // a handler that is an unhandled 'error' event, which takes pi down with
    // it — the child dying must never kill the session.
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      this.options.onStderr(`spawn failed: ${err.message}\n`);
      this.teardown(new Error(`channel process could not start: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      const how = signal ? `signal ${signal}` : `code ${code}`;
      this.teardown(new Error(`channel process exited (${how})`));
      this.options.onExit(code, signal);
    });

    const result = (await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          // We consume the channel notifications, and we authenticate the
          // replier before acting on a permission decision — which is what
          // declaring the permission capability asserts. The sidecar's gate()
          // is what makes that true.
          experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
        },
        clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
      },
      this.options.connectTimeoutMs
    )) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };

    // Per spec the server may hold notifications until this arrives. The
    // sidecar in fact starts its Matrix load on it, so skipping it would stall
    // the channel for the full fallback timer.
    this.notify('notifications/initialized', {});
    this.initialized = true;

    if (result?.protocolVersion && result.protocolVersion !== PROTOCOL_VERSION) {
      this.options.onStderr(
        `note: sidecar negotiated protocol ${result.protocolVersion} (we asked for ${PROTOCOL_VERSION})\n`
      );
    }
  }

  /** Call a tool on the sidecar. Rejects on transport failure, not on `isError`. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs
  ): Promise<ToolCallResult> {
    const result = (await this.request(
      'tools/call',
      { name, arguments: args },
      timeoutMs
    )) as ToolCallResult;
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      ...(result?.isError ? { isError: true } : {}),
    };
  }

  /** The sidecar's tool list. Used to verify the payload is the one we expect. */
  async listTools(timeoutMs = this.options.requestTimeoutMs): Promise<string[]> {
    const result = (await this.request('tools/list', {}, timeoutMs)) as {
      tools?: Array<{ name?: string }>;
    };
    return (result?.tools ?? []).map((tool) => tool?.name).filter((n): n is string => !!n);
  }

  /** Fire-and-forget. Notifications have no id and no reply by definition. */
  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /**
   * Stop the child.
   *
   * SIGTERM first: the sidecar's handler flushes the Olm crypto store, and
   * losing that forces every peer to re-key on the next boot. SIGKILL only if
   * it has not gone by `graceMs`.
   */
  async stop(graceMs = 5_000): Promise<void> {
    const child = this.child;
    if (!child || this.closed) return;
    this.closed = true;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        done();
      }, graceMs);
      killTimer.unref?.();
      child.once('exit', done);
      try {
        // Closing stdin is the sidecar's documented shutdown signal and works
        // even where signals do not; the SIGTERM is the belt to that braces.
        child.stdin.end();
        child.kill('SIGTERM');
      } catch {
        done();
      }
    });

    this.failPending(new Error('channel stopped'));
    this.child = null;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error('the Matrix channel is not running'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.closed) throw new Error('the Matrix channel is not running');
    // JSON.stringify never emits a raw newline, so one message really is one
    // line — which is the entire framing contract.
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    // A chunk boundary can fall anywhere, including mid-token; only complete
    // lines are parseable, so the tail is carried to the next chunk.
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this.dispatch(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // The sidecar's stdout-guard exists precisely so this cannot happen. If
      // it does, the line is the evidence — log it rather than a verdict about
      // it, because the verdict is the part most likely to be wrong.
      this.options.onStderr(`unparseable line on the channel transport: ${line.slice(0, 400)}\n`);
      return;
    }

    const id = message.id;
    if (typeof id === 'number') {
      const pending = this.pending.get(id);
      if (!pending) return; // Reply to a request we already timed out.
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = message.error as JsonRpcError;
        pending.reject(new Error(`${pending.method}: ${error?.message ?? 'unknown error'}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string') {
      const params = (message.params ?? {}) as Record<string, unknown>;
      // A server-initiated *request* (has an id) is not something this client
      // implements. Answering "method not found" is better than silence, which
      // would hang the server on a promise forever.
      if (message.id !== undefined) {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `method not found: ${message.method}` },
        });
        return;
      }
      try {
        this.options.onNotification(message.method, params);
      } catch (err) {
        this.options.onStderr(`notification handler threw: ${err}\n`);
      }
    }
  }

  private onStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk;
    let index = this.stderrBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stderrBuffer.slice(0, index + 1);
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      this.options.onStderr(line);
      index = this.stderrBuffer.indexOf('\n');
    }
  }

  private teardown(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;
    this.failPending(reason);
  }

  private failPending(reason: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(reason);
    }
  }

  get handshakeComplete(): boolean {
    return this.initialized;
  }
}

/** The text of a tool result, joined — what the model actually wants back. */
export function resultText(result: ToolCallResult): string {
  return result.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

/** Spawn helper kept separate so tests can drive `McpChild` against a fake server. */
export function createChild(options: McpChildOptions): McpChild {
  return new McpChild(options);
}
