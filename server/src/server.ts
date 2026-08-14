#!/usr/bin/env node
/**
 * Matrix channel — the sidecar.
 *
 * A self-contained MCP server that logs into Matrix as a bot, hands messages
 * from allowlisted senders to its client, and exposes tools for answering
 * with. Access control — pairing, allowlists, per-room policy — lives in
 * `<state-dir>/access.json` and is managed by the `/prinny` command.
 *
 * **Its client is the pi extension in `../../extensions/index.ts`, not an
 * agent harness.** It runs as a child process for two reasons that are not
 * negotiable in pi: loading matrix-js-sdk plus its Rust crypto WASM blocks the
 * event loop for ~15 seconds, which in an in-process extension would freeze
 * pi's TUI outright; and the same library writes to stdout while it loads,
 * which in-process would corrupt the terminal pi is drawing on. A child
 * process makes both somebody else's file descriptors.
 *
 * The MCP surface is kept exactly as upstream — including the
 * `notifications/claude/channel` method names — so this file can still be
 * diffed against prinny-mono/prinny-channel. See ../../FORK.md.
 *
 * Ported from Anthropic's official Telegram channel plugin
 * (anthropics/claude-plugins-official, Apache-2.0), onto @prinny/bot. The
 * channel protocol, the access model and the permission relay are theirs; the
 * Matrix half, the inline-keyboard permission prompt, history and search are
 * this port's.
 */

// FIRST, and it must stay first: this takes fd 1 for the MCP transport and
// points every other writer at stderr. matrix-js-sdk logs to stdout while it
// loads, which corrupts the JSON-RPC stream before any later import could
// intervene.
import { mcpStdout, divertedWrites } from './stdout-guard.js';

import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
// Everything Matrix comes through @prinny/bot, including the SDK symbols it
// re-exports. Installing matrix-js-sdk alongside it loads a second copy, which
// the SDK refuses outright — "Multiple matrix-js-sdk entrypoints detected!".
/**
 * The Matrix layer is imported for its **types only** at load time.
 *
 * `import type` is erased, so this costs nothing at runtime — which is the
 * point. Loading matrix-js-sdk and its Rust crypto module takes around fifteen
 * seconds on a slow filesystem, and the pi extension gives this child a bounded
 * window to complete its handshake. Importing it up here spends that budget
 * before `mcp.connect()` is even reached, and the channel is declared dead.
 *
 * The real module is pulled in by `loadMatrix()` *after* the transport is
 * connected, so the handshake is immediate and the slow part happens while the
 * session is already usable.
 */
import type {
  Bot,
  Context,
  InlineKeyboard,
  MatrixEvent,
  MessageOptions,
  Room,
} from '@prinny/bot';

/** The Matrix layer, once loaded. Null until `loadMatrix()` resolves. */
let matrix: typeof import('@prinny/bot') | null = null;

function requireMatrix(): typeof import('@prinny/bot') {
  if (!matrix) throw new Error('the Matrix layer is still loading — try again in a moment');
  return matrix;
}

import {
  assertAllowedRoom,
  checkApprovals,
  gate,
  commandGate,
  loadAccess,
  type Access,
} from './access.js';
import { fetchMessages, renderHistory, searchMessages } from './history.js';
import {
  MAX_ATTACHMENT_BYTES,
  assertSendable,
  assertWithinSizeLimit,
  kindForPath,
  sanitizeName,
  writeToInbox,
} from './inbox.js';
import { isMentioned } from './mentions.js';
import { PERMISSION_CALLBACK_RE, parsePermissionReply } from './permissions.js';
import { enqueue, flush, readQueue, readWatermark } from './queue.js';
import {
  CRYPTO_SNAPSHOT_PATH,
  CRYPTO_STORE_PATH,
  PID_FILE,
  STATE_DIR,
  loadEnvFile,
  log,
  readCredentials,
  updateEnvFile,
} from './state.js';

loadEnvFile();

const credentials = readCredentials();
if (!credentials.ok) {
  process.stderr.write(`prinny channel: ${credentials.error}`);
  process.exit(1);
}
const { value: creds } = credentials;

// ── Single-poller guard ──────────────────────────────────────────────────────
// Two bots syncing as the same device duplicate every delivery and fight over
// the crypto store, which is how a bot ends up unable to decrypt its own
// rooms. A session killed with SIGKILL leaves its server as an orphan holding
// that store, so any stale holder is replaced before we start.
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try {
  const stale = Number.parseInt(readFileSync(PID_FILE, 'utf8'), 10);
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0);
    // PID files race with OS PID recycling. Confirm the holder is actually one
    // of ours before signalling it — a recycled PID could be this session's own
    // node wrapper, and killing that takes the channel down with it.
    const cmd = execFileSync('ps', ['-p', String(stale), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (cmd.includes('prinny-channel') || cmd.includes('dist/server.js')) {
      log(`replacing stale poller pid=${stale}`);
      process.kill(stale, 'SIGTERM');
    }
  }
} catch {
  // No pid file, not running, or `ps` unavailable (Windows). Carry on.
}
writeFileSync(PID_FILE, String(process.pid));

// Without these the process dies silently on any unhandled rejection. With
// them it logs and keeps serving tools.
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err}`));
process.on('uncaughtException', (err) => log(`uncaught exception: ${err}`));

/**
 * The bot, once it exists.
 *
 * Construction is deferred until the device ID is known (see
 * `resolveDeviceId`), so the MCP transport can come up and answer immediately
 * rather than waiting on the homeserver. Tools called before then get a
 * sentence explaining the state instead of an internal error.
 */
let bot: Bot | null = null;

function requireBot(): Bot {
  if (!bot) {
    throw new Error(
      'the Matrix channel is not connected yet — it is still starting or retrying. ' +
        'Check the channel log for the connection error.'
    );
  }
  return bot;
}

function buildBot(deviceId: string | undefined): Bot {
  const watermark = readWatermark();
  if (watermark === 0) {
    log('no delivery watermark yet — starting from now, not from room history');
  }
  return new (requireMatrix().Bot)({
    homeserverUrl: creds.homeserverUrl,
    userId: creds.userId,
    ...(creds.accessToken ? { accessToken: creds.accessToken } : {}),
    ...(creds.password ? { password: creds.password } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(creds.storePassphrase ? { storePassphrase: creds.storePassphrase } : {}),
    // Pick up whatever arrived while no session was running — but only once
    // there is a watermark to measure "while" against. With no record of what
    // has been delivered, a floor of 0 means everything the initial sync
    // returns counts as missed, so a fresh install would dump the last fifty
    // messages of every room into the session as backlog.
    ...(watermark > 0 ? { catchUpFrom: watermark } : {}),
    // Bounds the catch-up: it can only see what the initial sync returns per
    // room, so a long enough outage still loses the oldest of it.
    initialSyncLimit: 50,
    allowUnencrypted: creds.allowUnencrypted,
    storePath: CRYPTO_STORE_PATH,
    cryptoSnapshotPath: CRYPTO_SNAPSHOT_PATH,
    // This channel gates every message itself, in gate(). The built-in control
    // would refuse unknown senders *with a reply*, which would turn a silent
    // drop into a "something is listening here" oracle.
    access: false,
    rateLimit: false,
    // Invites are accepted deliberately below, so a policy of `allowlist` or
    // `disabled` does not have the bot joining rooms it will never answer in.
    autoJoin: false,
    logger: (message) => log(message),
    // Re-logging in on every boot mints a new device, and peers stop sharing
    // room keys with a device whose identity keeps changing.
    onCredentials: ({ accessToken, deviceId: minted }) => {
      updateEnvFile({
        PRINNY_ACCESS_TOKEN: accessToken,
        ...(minted ? { PRINNY_DEVICE_ID: minted } : {}),
      });
      log('stored the minted access token — later boots will not re-login');
    },
  });
}

/**
 * The device ID that goes with an access token.
 *
 * Rust crypto refuses to initialise without one ("Cannot enable encryption on
 * MatrixClient with unknown deviceId"), and a token pasted by hand does not
 * carry it — so the bot would refuse to start with an error that names neither
 * the cause nor the fix. `/account/whoami` has returned `device_id` since
 * Matrix 1.1, so ask instead of failing.
 *
 * A password login is unaffected: it mints both, and `onCredentials` saves
 * them.
 */
async function resolveDeviceId(): Promise<string | undefined> {
  if (creds.deviceId) return creds.deviceId;
  if (!creds.accessToken) return undefined;

  const url = `${creds.homeserverUrl.replace(/\/+$/, '')}/_matrix/client/v3/account/whoami`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `whoami failed with HTTP ${response.status} — is PRINNY_ACCESS_TOKEN still valid? ` +
        'Re-run /prinny configure with the password to mint a fresh one.'
    );
  }
  const body = (await response.json()) as { device_id?: string; user_id?: string };
  if (body.user_id && body.user_id !== creds.userId) {
    throw new Error(
      `the access token belongs to ${body.user_id}, not PRINNY_USER_ID (${creds.userId})`
    );
  }
  if (!body.device_id) {
    throw new Error(
      'the homeserver did not return a device_id for this token. Set PRINNY_DEVICE_ID by hand, ' +
        'or configure a password so the bot can log in and mint its own.'
    );
  }
  // Persist it so the next boot skips the round trip.
  updateEnvFile({ PRINNY_DEVICE_ID: body.device_id });
  log(`resolved device ${body.device_id} from the access token`);
  return body.device_id;
}

const COMMANDS = [
  { command: 'start', description: 'Welcome and setup guide' },
  { command: 'help', description: 'What this bot can do' },
  { command: 'status', description: 'Check your pairing status' },
];

// ── Room helpers ─────────────────────────────────────────────────────────────

/**
 * Rooms the outbound tools may target: a two-person room whose other member is
 * on the allowlist, plus every explicitly enabled room.
 *
 * Matrix has no DM flag a bot can trust — `m.direct` is per-account data the
 * other side controls — so two joined members is the rule, matching what
 * @prinny/bot's `ctx.isDirect` uses for the inbound gate.
 *
 * Computed rather than stored, so removing someone from the allowlist closes
 * their room in the same breath.
 */
function allowedDirectRooms(access: Access): Set<string> {
  const rooms = new Set<string>();
  for (const room of requireBot().matrixClient.getRooms()) {
    if (room.getMyMembership() !== 'join') continue;
    if (room.getJoinedMemberCount() !== 2) continue;
    const other = room
      .getJoinedMembers()
      .map((member) => member.userId)
      .find((userId) => userId !== creds.userId);
    if (other && access.allowFrom.includes(other)) rooms.add(room.roomId);
  }
  return rooms;
}

/** The DM room for an allowlisted sender, if one exists. */
function directRoomFor(senderId: string): string | undefined {
  for (const room of requireBot().matrixClient.getRooms()) {
    if (room.getMyMembership() !== 'join') continue;
    if (room.getJoinedMemberCount() !== 2) continue;
    if (room.getJoinedMembers().some((member) => member.userId === senderId)) return room.roomId;
  }
  return undefined;
}

function assertTargetRoom(roomId: string): void {
  assertAllowedRoom(roomId, allowedDirectRooms(loadAccess()));
}

function sendOptionsFor(access: Access, replyTo?: string): MessageOptions {
  const options: MessageOptions = {
    parse_mode: access.format === 'text' ? 'None' : 'Markdown',
  };
  if (access.notice) options.notice = true;
  if (access.textChunkLimit) options.chunk_limit = access.textChunkLimit;
  if (replyTo && access.replyToMode !== 'off') options.reply_to_message_id = replyTo;
  return options;
}

// ── MCP server ───────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'prinny', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        // Permission-relay opt-in. Declaring this asserts that we authenticate
        // the replier, which gate() does: a sender not on the allowlist never
        // reaches the handler that emits a permission decision. A server that
        // cannot authenticate the replier must not declare this.
        'claude/channel/permission': {},
      },
    },
    // Deliberately terse. This server no longer talks to a model: its only
    // client is the pi extension, which composes the model-facing guidance
    // itself from the tool descriptions and promptGuidelines it registers.
    // Duplicating that guidance here would be a second copy to keep in sync
    // that nothing reads.
    instructions:
      'Matrix transport for the pi prinny channel. The sole client is the ' +
      'prinny pi extension: it proxies these tools to pi and turns ' +
      'notifications/claude/channel into a pi turn.',
  }
);

// ── Permission relay ─────────────────────────────────────────────────────────

/** Full details for the "See more" expansion, keyed by request id. */
const pendingPermissions = new Map<
  string,
  { tool_name: string; description: string; input_preview: string }
>();

function permissionKeyboard(requestId: string, expanded = false): InlineKeyboard {
  const keyboard = new (requireMatrix().InlineKeyboard)();
  if (!expanded) keyboard.text('See more', `perm:more:${requestId}`);
  return keyboard.primary('Allow', `perm:allow:${requestId}`).danger('Deny', `perm:deny:${requestId}`);
}

/**
 * A permission prompt from the pi extension, fanned out to every paired sender's
 * direct room.
 *
 * Shared rooms are deliberately excluded: everyone in `allowFrom` passed an
 * explicit pairing step, and a room member has not.
 */
mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    const { request_id, tool_name, description, input_preview } = params;
    pendingPermissions.set(request_id, { tool_name, description, input_preview });

    const access = loadAccess();
    // The listing under the buttons is what makes this work on a client with no
    // button support: they read "[1] Allow" and reply "1". @prinny/bot resolves
    // that back into the same callback the button press produces.
    const text = `🔐 Permission requested: **${tool_name}**`;
    for (const senderId of access.allowFrom) {
      const roomId = directRoomFor(senderId);
      if (!roomId) {
        log(`no direct room with ${senderId} yet — permission prompt not delivered there`);
        continue;
      }
      void requireBot()
        .api.sendMessage(roomId, text, { reply_markup: permissionKeyboard(request_id) })
        .catch((err) => log(`permission prompt to ${roomId} failed: ${err}`));
    }
  }
);

function decidePermission(requestId: string, behavior: 'allow' | 'deny'): void {
  void mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id: requestId, behavior },
  });
  pendingPermissions.delete(requestId);
}

// ── Tools ────────────────────────────────────────────────────────────────────

const ROOM_ID_SCHEMA = {
  type: 'string',
  description: 'Matrix room ID from the inbound <channel> block, e.g. !abc:example.org',
} as const;

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'THE ONLY WAY TO ANSWER A <channel> MESSAGE FROM MATRIX. Transcript text is not delivered to the sender — if you do not call this, they receive nothing. ' +
        'Pass room_id from the inbound message. Text is rendered as Markdown by default. Optionally pass reply_to (a message_id) to quote-reply, and files (absolute paths) to attach images, video, audio or documents.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: ROOM_ID_SCHEMA,
          text: { type: 'string' },
          reply_to: {
            type: 'string',
            description: 'Event ID to reply to. Use message_id from the inbound <channel> block.',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Absolute file paths to attach. Images, video and audio are sent with the matching msgtype so clients render them inline; anything else goes as a document. Encrypted automatically in an encrypted room.',
          },
          format: {
            type: 'string',
            enum: ['markdown', 'text', 'html'],
            description:
              "How to render text. 'markdown' (default) supports bold, lists, links and code blocks with no escaping. 'text' sends it verbatim. 'html' takes Matrix's HTML subset.",
          },
        },
        required: ['room_id', 'text'],
      },
    },
    {
      name: 'react',
      description:
        'Add an emoji reaction to a message. Matrix accepts any emoji — there is no whitelist.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: ROOM_ID_SCHEMA,
          message_id: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['room_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description:
        'Edit a message the bot previously sent, as a normal Matrix edit. Useful for "working…" → result progress updates. Edits do not trigger push notifications, so send a new reply when a long task completes.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: ROOM_ID_SCHEMA,
          message_id: { type: 'string', description: 'Event ID of the bot message to edit.' },
          text: { type: 'string' },
          format: { type: 'string', enum: ['markdown', 'text', 'html'] },
        },
        required: ['room_id', 'message_id', 'text'],
      },
    },
    {
      name: 'download_attachment',
      description:
        'Download the attachment on a message to the local inbox, decrypting it when the room is encrypted. Use when the inbound <channel> meta shows attachment_kind. Returns a local path ready to Read.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: ROOM_ID_SCHEMA,
          message_id: { type: 'string', description: 'Event ID carrying the attachment.' },
        },
        required: ['room_id', 'message_id'],
      },
    },
    {
      name: 'fetch_messages',
      description:
        'Fetch recent messages from a room, oldest first, with event IDs. Backfills from the server when the synced timeline is short, and decrypts as needed.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: ROOM_ID_SCHEMA,
          limit: { type: 'number', description: 'How many messages to return. Default 50, max 200.' },
        },
        required: ['room_id'],
      },
    },
    {
      name: 'search',
      description:
        'Server-side full-text search within one room. Cannot see an end-to-end encrypted room — the homeserver holds only ciphertext — and says so explicitly rather than returning nothing. Use fetch_messages there instead.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: ROOM_ID_SCHEMA,
          query: { type: 'string' },
          limit: { type: 'number', description: 'Max results. Default 20, max 200.' },
        },
        required: ['room_id', 'query'],
      },
    },
  ],
}));

function parseMode(format: unknown): MessageOptions['parse_mode'] {
  if (format === 'text') return 'None';
  if (format === 'html') return 'HTML';
  return 'Markdown';
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  // `chat_id` is accepted as an alias so a prompt carried over from another
  // channel still works instead of failing on an unfamiliar parameter name.
  const roomId = (args.room_id ?? args.chat_id) as string;

  try {
    switch (req.params.name) {
      case 'reply': {
        const text = args.text as string;
        const replyTo = args.reply_to != null ? String(args.reply_to) : undefined;
        const files = (args.files as string[] | undefined) ?? [];

        assertTargetRoom(roomId);
        for (const file of files) {
          assertSendable(file);
          assertWithinSizeLimit(file);
        }

        const access = loadAccess();
        const options = sendOptionsFor(access, replyTo);
        options.parse_mode = parseMode(args.format);

        const eventIds = await requireBot().api.sendMessage(roomId, text, options);

        // Attachments are separate events; a Matrix message carries either a
        // body or a file, never both.
        for (const file of files) {
          const source = { path: file, filename: basename(file) };
          const mediaOptions = replyTo && access.replyToMode !== 'off'
            ? { reply_to_message_id: replyTo }
            : {};
          let sent: string | null;
          switch (kindForPath(file)) {
            case 'image':
              sent = await requireBot().api.sendPhoto(roomId, source, mediaOptions);
              break;
            case 'video':
              sent = await requireBot().api.sendVideo(roomId, source, mediaOptions);
              break;
            case 'audio':
              sent = await requireBot().api.sendAudio(roomId, source, mediaOptions);
              break;
            default:
              sent = await requireBot().api.sendDocument(roomId, source, mediaOptions);
          }
          if (sent) eventIds.push(sent);
        }

        const result =
          eventIds.length === 1
            ? `sent (id: ${eventIds[0]})`
            : `sent ${eventIds.length} parts (ids: ${eventIds.join(', ')})`;
        return { content: [{ type: 'text', text: result }] };
      }

      case 'react': {
        assertTargetRoom(roomId);
        await requireBot().api.react(roomId, args.message_id as string, args.emoji as string);
        return { content: [{ type: 'text', text: 'reacted' }] };
      }

      case 'edit_message': {
        assertTargetRoom(roomId);
        const edited = await requireBot().api.editMessageText(
          roomId,
          args.message_id as string,
          args.text as string,
          { parse_mode: parseMode(args.format) }
        );
        return { content: [{ type: 'text', text: `edited (id: ${edited ?? args.message_id})` }] };
      }

      case 'download_attachment': {
        assertTargetRoom(roomId);
        const messageId = args.message_id as string;
        const path = await downloadFromEvent(roomId, messageId);
        return { content: [{ type: 'text', text: path }] };
      }

      case 'fetch_messages': {
        assertTargetRoom(roomId);
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const entries = await fetchMessages(requireBot().matrixClient, roomId, limit);
        return { content: [{ type: 'text', text: renderHistory(entries) }] };
      }

      case 'search': {
        assertTargetRoom(roomId);
        const limit = typeof args.limit === 'number' ? args.limit : 20;
        const outcome = await searchMessages(
          requireBot().matrixClient,
          roomId,
          args.query as string,
          limit
        );
        if (!outcome.ok) {
          return {
            content: [{ type: 'text', text: `search unavailable: ${outcome.reason}` }],
            isError: true,
          };
        }
        const header = `${outcome.results.length} of ~${outcome.count} match(es)`;
        return {
          content: [{ type: 'text', text: `${header}\n${renderHistory(outcome.results)}` }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${message}` }],
      isError: true,
    };
  }
});

/** Resolve an event by ID — from the timeline if synced, from the server if not. */
async function loadEvent(roomId: string, eventId: string): Promise<MatrixEvent> {
  const room = requireBot().matrixClient.getRoom(roomId);
  const known = room?.findEventById(eventId);
  if (known) {
    if (known.isEncrypted()) await requireBot().matrixClient.decryptEventIfNeeded(known);
    return known;
  }
  const raw = await requireBot().matrixClient.fetchRoomEvent(roomId, eventId);
  const mapper = requireBot().matrixClient.getEventMapper();
  const event = mapper(raw as never);
  if (event.isEncrypted()) await requireBot().matrixClient.decryptEventIfNeeded(event);
  return event;
}

async function downloadFromEvent(roomId: string, eventId: string): Promise<string> {
  const event = await loadEvent(roomId, eventId);
  const content = event.getContent() as Record<string, unknown>;
  if (!content.url && !content.file) {
    throw new Error(`message ${eventId} has no attachment`);
  }
  const file = await requireBot().api.downloadAttachment(content as never, {
    maxBytes: MAX_ATTACHMENT_BYTES,
  });
  return writeToInbox(file.data, file.filename, eventId);
}

// ── Inbound ──────────────────────────────────────────────────────────────────

type AttachmentMeta = {
  kind: string;
  name?: string | undefined;
  mime?: string | undefined;
  size?: number | undefined;
};

function attachmentMetaOf(ctx: Context): AttachmentMeta | undefined {
  const attachment = ctx.attachment;
  if (!attachment) return undefined;
  const msgtype = (ctx.event.getContent() as Record<string, unknown>).msgtype;
  const kind = ctx.isVoiceMessage
    ? 'voice'
    : typeof msgtype === 'string'
      ? msgtype.replace(/^m\./, '')
      : 'file';
  return {
    kind,
    name: sanitizeName(attachment.body),
    mime: attachment.info?.mimetype,
    size: attachment.info?.size,
  };
}

/** Images are fetched eagerly so the assistant can Read them without a round trip. */
async function downloadIfImage(ctx: Context): Promise<string | undefined> {
  const attachment = ctx.attachment;
  const msgtype = (ctx.event.getContent() as Record<string, unknown>).msgtype;
  if (!attachment || (msgtype !== 'm.image' && ctx.event.getType() !== 'm.sticker')) {
    return undefined;
  }
  try {
    const file = await ctx.download({ maxBytes: MAX_ATTACHMENT_BYTES });
    return writeToInbox(file.data, file.filename, ctx.messageId);
  } catch (err) {
    // Not fatal: the message still reaches the session with attachment_kind
    // set, so the assistant can retry deliberately with download_attachment.
    log(`image download failed: ${err}`);
    return undefined;
  }
}

function replyToSenderOf(ctx: Context): string | undefined {
  const relation = (ctx.event.getContent() as Record<string, unknown>)['m.relates_to'] as
    | { 'm.in_reply_to'?: { event_id?: string } }
    | undefined;
  const target = relation?.['m.in_reply_to']?.event_id;
  if (!target) return undefined;
  return ctx.room.findEventById(target)?.getSender() ?? undefined;
}

/**
 * Whether the session is ready to be handed messages.
 *
 * The MCP client discards channel notifications sent before it acknowledges
 * the handshake, so anything that arrives during the fifteen seconds the
 * Matrix layer takes to load has to wait in the queue rather than be sent into
 * a void.
 */
let sessionReady = false;

/**
 * Drain the queue into the session, oldest first.
 *
 * Serialised: two concurrent drains would interleave a conversation, and a
 * message arriving mid-drain must land after the backlog, not in the middle of
 * it.
 */
let draining: Promise<unknown> = Promise.resolve();

function flushQueue(): Promise<unknown> {
  if (!sessionReady) return Promise.resolve();
  draining = draining.then(async () => {
    const { delivered, remaining } = await flush(async (message, index, total) => {
      const stale = Date.now() - message.ts > 60_000;
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: message.content,
          meta: {
            ...message.meta,
            // Tell the assistant this is a backlog item, so it can answer in
            // the right tense instead of treating an hours-old message as
            // something just said.
            ...(stale
              ? {
                  delayed: 'true',
                  queued_for: `${Math.round((Date.now() - message.ts) / 1000)}s`,
                  backlog_position: `${index + 1}/${total}`,
                }
              : {}),
          },
        },
      });
    });
    if (delivered > 0) log(`delivered ${delivered} queued message(s), ${remaining} left`);
  });
  return draining;
}

async function handleInbound(ctx: Context): Promise<void> {
  const senderId = ctx.from;
  const roomId = ctx.roomId;
  if (!senderId || senderId === creds.userId) return;

  const access = loadAccess();
  const mentionsBot = isMentioned(
    {
      text: ctx.text,
      html: (ctx.event.getContent() as Record<string, unknown>).formatted_body as
        | string
        | undefined,
      mentionedUserIds: (
        (ctx.event.getContent() as Record<string, unknown>)['m.mentions'] as
          | { user_ids?: string[] }
          | undefined
      )?.user_ids,
      replyToSender: replyToSenderOf(ctx),
    },
    {
      botUserId: creds.userId,
      botDisplayName: ctx.room.getMember(creds.userId)?.name,
      patterns: access.mentionPatterns,
    }
  );

  const result = gate({ senderId, roomId, isDirect: ctx.isDirect, mentionsBot });

  if (result.action === 'drop') return;

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required';
    await ctx.reply(
      `${lead} — run this in pi:\n\n    /prinny pair ${result.code}`
    );
    return;
  }

  const text = ctx.text;
  const messageId = ctx.messageId;

  // A permission answer is a decision, not conversation. The sender is already
  // through the gate at this point, which is what makes trusting it safe.
  const decision = parsePermissionReply(text);
  if (decision) {
    decidePermission(decision.requestId, decision.behavior);
    void ctx.react(decision.behavior === 'allow' ? '✅' : '❌').catch(() => undefined);
    return;
  }

  // Typing signals "working on it" until the reply lands.
  void ctx.typing(true).catch(() => undefined);
  if (access.ackReaction) void ctx.react(access.ackReaction).catch(() => undefined);

  const attachment = attachmentMetaOf(ctx);
  const imagePath = await downloadIfImage(ctx);

  // Queued first, delivered second. A crash between the two leaves the message
  // waiting rather than lost, which is the whole point of the outbox.
  const queued = enqueue({
    id: messageId,
    ts: ctx.event.getTs(),
    content: text || (attachment ? `(${attachment.kind})` : ''),
    meta: {
      room_id: roomId,
      // Emitted under both names: `chat_id` is what the other channel
      // plugins use, and costs nothing to keep compatible.
      chat_id: roomId,
      message_id: messageId,
      user: ctx.fromName,
      user_id: senderId,
      ts: new Date(ctx.event.getTs()).toISOString(),
      is_direct: String(ctx.isDirect),
      // Only in meta — an inline "[image at PATH]" note in the content
      // would be forgeable by any allowlisted sender typing that string.
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachment
        ? {
            attachment_kind: attachment.kind,
            ...(attachment.name ? { attachment_name: attachment.name } : {}),
            ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
            ...(attachment.size != null
              ? { attachment_size: String(attachment.size) }
              : {}),
          }
        : {}),
    },
  });

  // Already delivered on an earlier run — the catch-up re-offers everything
  // the initial sync returns, and most of it is old news.
  if (!queued) return;

  await flushQueue();
}

// ── Bot handlers ─────────────────────────────────────────────────────────────
// Commands answer in direct rooms only. In a shared room they would leak a
// pairing code to everyone present, and confirm the bot's presence in rooms
// its operator never approved.

function registerHandlers(bot: Bot): void {
  bot.command('start', async (ctx) => {
    if (!commandGate({ senderId: ctx.from, isDirect: ctx.isDirect })) return;
    await ctx.reply(
      'This bot bridges Matrix to a pi session.\n\n' +
        'To pair:\n' +
        '1. Send me anything — you will get a 6-character code\n' +
        '2. In pi, run: `/prinny pair <code>`\n\n' +
        'After that, messages here reach that session.'
    );
  });

  bot.command('help', async (ctx) => {
    if (!commandGate({ senderId: ctx.from, isDirect: ctx.isDirect })) return;
    await ctx.reply(
      'Messages you send here route to a paired pi session. Text, images and ' +
        'files are forwarded; replies, edits and reactions come back.\n\n' +
        '/start — pairing instructions\n' +
        '/status — check your pairing state'
    );
  });

  bot.command('status', async (ctx) => {
    const gated = commandGate({ senderId: ctx.from, isDirect: ctx.isDirect });
    if (!gated) return;
    const { access, senderId } = gated;

    if (access.allowFrom.includes(senderId)) {
      await ctx.reply(`Paired as ${senderId}.`);
      return;
    }
    for (const [code, entry] of Object.entries(access.pending)) {
      if (entry.senderId === senderId) {
        await ctx.reply(`Pending — run this in pi:\n\n    /prinny pair ${code}`);
        return;
      }
    }
    await ctx.reply('Not paired. Send me a message to get a pairing code.');
  });

  /**
   * Button presses on a permission prompt.
   *
   * @prinny/bot delivers a plain-text "1" or "Allow" through this same handler,
   * so a client with no button support is served by the identical code path
   * rather than a second one that drifts.
   */
  bot.callbackQuery(PERMISSION_CALLBACK_RE, async (ctx) => {
    const behavior = ctx.match?.[1] as 'allow' | 'deny' | 'more' | undefined;
    const requestId = ctx.match?.[2];
    if (!behavior || !requestId) return;

    const access = loadAccess();
    if (!access.allowFrom.includes(ctx.from)) {
      await ctx.answerCallbackQuery({ text: 'Not authorised.' }).catch(() => undefined);
      return;
    }

    if (behavior === 'more') {
      const details = pendingPermissions.get(requestId);
      if (!details) {
        await ctx
          .answerCallbackQuery({ text: 'Those details are no longer available.' })
          .catch(() => undefined);
        return;
      }
      let preview = details.input_preview;
      try {
        preview = JSON.stringify(JSON.parse(details.input_preview), null, 2);
      } catch {
        // Not JSON; show it as it came.
      }
      const expanded =
        `🔐 Permission requested: **${details.tool_name}**\n\n` +
        `${details.description}\n\n` +
        '```json\n' +
        `${preview}\n` +
        '```';
      await ctx
        .editMessageText(expanded, { reply_markup: permissionKeyboard(requestId, true) })
        .catch(() => undefined);
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }

    // Read before deciding — decidePermission drops the entry.
    const details = pendingPermissions.get(requestId);
    decidePermission(requestId, behavior);
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied';
    await ctx.answerCallbackQuery({ text: label }).catch(() => undefined);
    // Retire the buttons, so the same request cannot be answered twice and the
    // room shows what was decided. The edit carries the outcome, because a
    // keyboard that simply vanishes reads as a failure.
    const heading = details ? `🔐 Permission: **${details.tool_name}**` : '🔐 Permission';
    await ctx.editMessageText(`${heading}\n\n${label}`).catch(() => undefined);
  });

  bot.on('message', async (ctx) => {
    await handleInbound(ctx);
  });

  bot.catch((error) => {
    log(`handler error (the bot keeps running): ${error instanceof Error ? error.stack : error}`);
  });
}

// ── Invites ──────────────────────────────────────────────────────────────────
// Joining is a decision, not a reflex: under `allowlist` or `disabled` there is
// nothing to gain from sitting in a stranger's room, and leaving tells them so
// without the bot ever reading a message.

function wireInvites(): void {
  requireBot().matrixClient.on(requireMatrix().RoomEvent.MyMembership, (room: Room, membership: string) => {
    if (membership !== 'invite') return;

    const access = loadAccess();
    // Our own membership event names whoever sent the invite.
    const inviter = room.getMember(creds.userId)?.events?.member?.getSender();
    const known = inviter !== undefined && access.allowFrom.includes(inviter);
    // Under `pairing` an unknown inviter is the expected case — that is how
    // someone reaches the bot to get a code in the first place. Under
    // `allowlist` or `disabled` there is nothing to gain by sitting in their
    // room, and leaving says so without ever reading a message.
    const accept = known || access.autoJoinUnknown === true || access.dmPolicy === 'pairing';

    if (!accept) {
      log(`declining invite to ${room.roomId} from ${inviter ?? 'unknown'} (${access.dmPolicy})`);
      void requireBot().matrixClient.leave(room.roomId).catch(() => undefined);
      return;
    }

    void requireBot().matrixClient
      .joinRoom(room.roomId)
      .then(() => requireBot().publishTo(room.roomId))
      .catch((err) => log(`join ${room.roomId} failed: ${err}`));
  });
}

// ── Approvals ────────────────────────────────────────────────────────────────

setInterval(() => {
  if (!started) return;
  checkApprovals(async (roomId, text) => {
    await requireBot().api.sendMessage(roomId, text);
  });
}, 5000).unref();

// ── Lifecycle ────────────────────────────────────────────────────────────────

let started = false;
let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  try {
    if (Number.parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) {
      rmSync(PID_FILE, { force: true });
    }
  } catch {
    // Already gone.
  }
  // stop() flushes the crypto store, which matters: losing the last minutes of
  // Olm state forces every peer to re-key on the next boot. Cap the wait so a
  // hung request cannot keep the process alive forever.
  const forced = setTimeout(() => process.exit(0), 5000);
  forced.unref();
  void Promise.resolve(bot?.stop())
    .catch(() => undefined)
    .finally(() => process.exit(0));
}

process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);

// Orphan watchdog, belt and braces for the stdin handlers above. Stdin is the
// MCP transport pipe inherited straight from the CLI, so the kernel closes it
// on any CLI death — clean exit, crash, SIGKILL or OOM — whatever wrappers sit
// in between.
setInterval(() => {
  if (process.stdin.destroyed || process.stdin.readableEnded) shutdown();
}, 5000).unref();

async function startMatrix(): Promise<void> {
  // Loading a module this large is synchronous CPU work — parsing and
  // instantiating matrix-js-sdk plus its Rust crypto WASM — and that **blocks
  // the event loop**. Starting it merely "after connect()" is not enough:
  // the initialize response is still sitting in the queue and cannot be
  // written until the import returns, so the client times out anyway.
  //
  // `oninitialized` fires once the client has acknowledged the handshake, which
  // is the first moment the connection is safe to stall.
  const startedLoading = Date.now();
  matrix = await import('@prinny/bot');
  log(`Matrix layer loaded in ${((Date.now() - startedLoading) / 1000).toFixed(1)}s`);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const deviceId = await resolveDeviceId();
      const next = buildBot(deviceId);
      registerHandlers(next);
      await next.setMyCommands(COMMANDS);
      await next.start();
      // Published only once `start()` resolves, so no tool can reach a client
      // that is half constructed.
      bot = next;
      wireInvites();
      started = true;
      log(`connected as ${creds.userId}`);
      const pending = readQueue().length;
      if (pending > 0) log(`${pending} message(s) queued while away — delivering`);
      void flushQueue();
      const stray = divertedWrites();
      if (stray > 0) {
        // Worth saying out loud: without the guard each of these would have
        // been a JSON-RPC parse error with no clue as to its origin.
        log(`kept ${stray} stray stdout write(s) off the MCP stream`);
      }
      return;
    } catch (err) {
      if (shuttingDown) return;
      const delay = Math.min(1000 * attempt, 30_000);
      log(`connection failed (attempt ${attempt}): ${err}; retrying in ${delay / 1000}s`);
      // Outbound tools would fail anyway without a client, and the session
      // stays alive on stdin, so retrying forever beats exiting: a homeserver
      // that comes back should not need the user to restart pi.
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// The transport gets the private handle on fd 1; nothing else can reach it.
await mcp.connect(new StdioServerTransport(process.stdin, mcpStdout));

// Handshake first, heavy lifting second. If the client never acknowledges,
// the fallback timer still brings the channel up rather than waiting forever.
let matrixStarted = false;
function beginMatrix(): void {
  if (matrixStarted) return;
  matrixStarted = true;
  // The client has acknowledged the handshake, so notifications will now be
  // routed rather than dropped.
  sessionReady = true;
  void startMatrix();
}
mcp.oninitialized = beginMatrix;
setTimeout(beginMatrix, 2000).unref();
