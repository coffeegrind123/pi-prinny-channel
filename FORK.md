# prinny-channel — converted to a pi extension

Converted from [`prinny-channel`](https://github.com/coffeegrind123/prinny-channel)
(MIT — `LICENSE` is upstream's, unchanged), which is a **Claude Code plugin**:
an MCP server that Claude Code launches, plus two skills. pi has no plugin
system, no channel protocol and no MCP-notification path into a session, so the
Claude Code half was replaced rather than adapted. The Matrix half was not
touched.

Vendored rather than installed for the same reason as `vendor/pi-loop-mode`: the
changes are edits to the package's own source, so an install would be replaced
by the next update and a patch on top of one would go with it.

## What it does

Talk to a pi session — and through it the local model — from any Matrix client.
A message from an allowlisted sender becomes a pi turn; the answer comes back
automatically.

```
Matrix  ⇄  sidecar (child process, MCP over stdio)  ⇄  extension  ⇄  pi
```

## Layout

```
vendor/prinny-channel/
  extensions/index.ts     the pi extension: tools, commands, forwarding, lifecycle
  src/                    pure modules, no dependencies, all tested
    config.ts             state paths and pi-side settings
    forwarding.ts         what of the assistant's output reaches Matrix
    inbound.ts            a Matrix message → the [matrix] line the model sees
    mcp-stdio.ts          the JSON-RPC client that drives the sidecar
    permission-gate.ts    which tool calls get relayed for approval
    access-store.ts       allowlist, pairing and room mutations
  server/                 the sidecar: upstream's payload, four edits (below)
  skills/                 two skills, rewritten to route through /prinny
  tests/                  231 tests, no node_modules
```

**Nothing under `vendor/` needs installing.** The extension and `src/` import
only `node:*`, plus `typebox`, `@earendil-works/pi-ai` and `@earendil-works/pi-tui`,
which pi resolves from its own module root — verified, not assumed: an extension
loaded by absolute path from outside pi's tree resolves all three.

The sidecar's ~105MB of Matrix dependencies are staged and compiled **outside
the repo**, at `~/.pi/agent/channels/prinny/runtime/`, by its own bootstrap.

## Why the sidecar is a child process

`@prinny/bot` pulls in matrix-js-sdk and its Rust crypto WASM. Two properties
make it unwelcome in pi's process:

1. **Loading it blocks the event loop for ~15 seconds.** In-process that is
   pi's TUI frozen solid at startup.
2. **It writes to stdout while it loads.** In pi, stdout and stderr *are* the
   TUI; one stray line scribbles over the interface.

Out of process, both are the child's problem: its stdout is a pipe carrying
JSON-RPC, and its stderr goes to `<state-dir>/channel.log`. It is also why the
extension never writes to the terminal itself — everything goes to that log,
with only state changes promoted to `ctx.ui.notify`.

The sidecar keeps upstream's MCP surface **exactly**, including the
`notifications/claude/channel` method names, so `server/src/server.ts` can still
be diffed against the upstream repo.

## Changes to `server/` (the sidecar)

Four, all small:

1. **State directory** — `~/.claude/channels/prinny` → `~/.pi/agent/channels/prinny`,
   honouring `PI_CODING_AGENT_DIR`. `PRINNY_STATE_DIR` still overrides. The same
   rule is written out in `src/config.ts`, and `tests/config.test.ts` compares
   the two rather than trusting them to stay in step.
2. **The bootstrap's checkout search** — upstream looked one or two levels up for
   a sibling `prinny-bot`. Vendored into a different repository, that finds
   nothing, so it now walks the ancestors and tries `prinny-mono/prinny-bot` at
   each. `PRINNY_BOT_PATH` still short-circuits it.
3. **MCP `instructions`** — upstream's model-facing guidance was deleted. The
   only client is the extension, which composes its own from the tool
   descriptions it registers; a second copy here would be one nothing reads.
4. **Wording** — user-visible strings say pi and `/prinny` instead of Claude Code
   and `/prinny:access`. These go out over Matrix, so they had to be right.

Not vendored: upstream's `.claude-plugin/`, `.mcp.json`, eslint and vitest
configs, and the dev-harness `package.json`.

## Changes on the pi side

### Inbound delivery

Claude Code turned a `notifications/claude/channel` notification into a
`<channel>` block. Nothing in pi does that, so the extension builds the text
itself and injects it with `pi.sendUserMessage(text, { deliverAs })`.

**It is one line, not a block.** The `<channel …>` form carried up to fourteen
attributes so the model could hand `room_id` back to a tool. Measured on this
stack's own traffic, that was 249 chars of wrapper around 29 chars of message
and 279 around 2 — 88% and 99% overhead, on every message forever. The model was
never the right place to hold a routing identifier it did not choose: the
extension knows which room the turn came from, so it keeps that itself
(`lastInbound`) and fills it in on the way out.

What the model sees now is `[matrix] <what they said>`, with an annotation only
when it changes the answer — `image=<path>`, `attachment=<kind>`, `from=<name>`
(rooms only; a DM has one possible sender), `delayed=<age>`. Same two messages:
38 chars and 25.

The marker is not decoration. It is the boundary between "the operator typed
this" and "a stranger sent this", which every untrusted-input guideline hangs
off, and it survives at about one token instead of sixty. A body line opening
with `[matrix]` is defused, and a display name is reduced to a charset that
cannot open a new `key=` — the same hole the old XML escaping closed, in the
grammar that replaced it. Both spoofs are in `tests/inbound.test.ts`.

`deliverAs` defaults to `followUp`, so a message arriving mid-turn joins the
queue instead of interrupting work the operator asked for. `steer` is available
for driving pi entirely from Matrix.

### Answers are forwarded, not requested

**This is the biggest behavioural change, and it exists because of the local
model.** Upstream made the `reply` tool the only way out, with a tool
description in capital letters saying so. That works at frontier scale. At 27B
it does not: the model writes a perfectly good answer into the transcript and
never calls the tool, and the failure is silent — the operator sees the answer,
the person on Matrix sees nothing.

So the extension forwards the assistant's **text** itself:

| `forward` | behaviour |
|---|---|
| `result` | the closing text of each Matrix-originated turn (**default**) |
| `all` | every assistant message as it completes, so a long task shows progress |
| `off` | nothing unless the model calls `prinny` with action `reply` |

Only `type: "text"` content is forwarded. Thinking blocks and tool calls are
not, and the filter is an **allowlist**, so a content kind added by a future pi
is excluded by default rather than leaked to a stranger's phone.

`prinny(reply)` remains, for what forwarding cannot do: attachments,
quote-replies, and sending a second message. Text sent both ways is deduplicated
on normalised content, because a model that both writes an answer *and* calls
the tool with it is the common case, not an edge one.

Forwarding is skipped when more than one room is waiting: the answer cannot be
attributed to one of them, and guessing would send one person's conversation to
another.

**A room only becomes eligible once pi has actually read its message.** This is
the subtle part, and getting it wrong leaks. A Matrix message can arrive while
pi is mid-turn on something the operator asked for in the terminal; it is
queued, correctly, as a follow-up. If the room counted as "waiting" from the
moment it arrived, the *current* turn's answer — about the operator's private
local work — would be forwarded to whoever just messaged, silently and
invisibly from this side.

So eligibility waits for evidence: pi emitting that message as a user message,
which is pi saying it has consumed it. The match is against **the exact string
that was injected**, recorded on the pending entry when it was sent.

That replaced parsing `message_id` back out of the block, and is strictly safer
rather than merely equivalent: an identifier can be *written* by a sender into
their own message body, which is why the old version needed a start-anchored,
no-`m`-flag regex to stop someone marking a room live by typing
`message_id="$somebody-elses"` at the bot. There is nothing to forge in a
whole-string comparison — a sender would have to reproduce the harness's own
rendering of their own message, which gains them nothing. With no record of what
was injected the answer is `false`: guessing forwards private terminal work to a
stranger, while refusing only means the answer goes out through the tool.
`blockMatches` in `src/forwarding.ts`, spoofs in the tests.

### The typing indicator follows "Working…", and has to be re-broadcast

The sidecar set typing when a message arrived and left it there. Matrix expires a
typing indicator on its own timeout — 20s — and a local 27B model routinely
thinks for longer, so it lapsed mid-thought: the sender saw a bot that had gone
quiet at exactly the moment the signal exists to say "still working".

Refreshing it turned out to be two problems, not one.

**The timing.** The indicator is now driven from the turn lifecycle — up between
`agent_start` and `agent_settled`, which is precisely when pi shows "Working…"
in the terminal. Not gated on whether a reply has been sent: a model that answers
and keeps working is still working. Gated on `entry.live`, so a turn the operator
started locally never tells a Matrix sender the bot is busy with something of
theirs.

**The broadcast.** Re-asserting `typing: true` while already typing is invisible
to clients. Verified against this homeserver: the first PUT produces an
`m.typing` EDU and a second one, with the typing set unchanged, produces
**nothing at all** — Synapse only broadcasts when the set changes. The
server-side expiry is refreshed so nothing removes the user either, and a client
that expires its own indicator locally shows typing briefly and then stops for
the rest of the turn. That is the reported symptom exactly.

So each assertion clears first (`restart: true`), which makes the set genuinely
change. Measured over a simulated 8s refresh loop: an EDU on every refresh, where
before only the first produced one.

It costs the model nothing. `typing` is exposed on the sidecar's MCP interface
but never passed to `pi.registerTool()`, so it is not in the schema —
`tests/tool-budget.test.ts` reads the tools array off the wire and still reports
1,333 chars. The reconciliation lives in `src/typing.ts` so it can be tested; it
reconciles rather than toggles, because rooms do not finish together and a stuck
typing indicator must not be able to outlive the state that justified it.

### Access management is a command, not a skill

Upstream's `/prinny:access` was a skill instructing the model to read
`access.json`, mutate it carefully, and write it back. That is a reasonable
design for a frontier model and a bad one here: a dropped key or a
re-serialised `pending` block is a silently broken allowlist, and the allowlist
is what stands between a public Matrix ID and a shell.

It is now `/prinny`, implemented in `src/access-store.ts` — read-modify-write on
every mutation, full-MXID and room-ID validation, no pairing ever approved
without its code. The skills remain, rewritten to explain which command to run.

### The permission relay

Upstream carried permission prompts *Claude Code* raised. pi raises none, so
there is nothing to carry — the extension has to decide for itself, via
`on("tool_call")`:

| `permissions` | behaviour |
|---|---|
| `off` | pi's own behaviour (**default**) |
| `dangerous` | ask before `rm -rf`, `sudo`, force push, `curl \| sh`, and similar |
| `all` | ask before every `bash`, `edit` and `write` |

It **fails closed**: channel down, or nobody answers in time, and the call is
blocked. Enabling it says these calls should not happen unwatched, and "the
approver was unreachable" is not "the approver said yes". `/prinny permissions
off` is the exit.

Request ids use the sidecar's five-letter, no-`l` alphabet, so a Matrix client
with no button support can still answer by typing `y <code>` — asserted in
`tests/permission-gate.test.ts` against the sidecar's own parser.

### Settings live in `pi.json`, not `access.json`

Tempting as one file is, `access.json` already has a writer: the sidecar
rewrites it whenever the gate mints or prunes a pairing, and its
`readAccessFile()` rebuilds the object from a fixed list of known keys — so any
key it does not know about is dropped. Settings kept there would vanish the
first time a stranger messaged the bot.

### One tool, and only when the channel is configured

Tool schemas are part of the request prefix on **every** turn. Measured
2026-08-16 by capturing what pi actually put on the wire against a stand-in
model: the six `prinny_*` tools were **1,470 tokens** — more than pi's own
`bash`, `read`, `edit` and `write` schemas combined (754), and 4.5% of a
32,768-token window, charged to every turn forever.

Two things followed from that.

`isConfigured()` already gated the sidecar, because an unconfigured channel
cannot run. It gates registration too, so a session with no Matrix credentials
pays nothing for a channel it cannot use.

And the six became **one**: `prinny`, dispatching on `action` — `reply`, `react`,
`edit`, `download`, `history`, `search`. Same measurement, same harness: the
channel's whole tool surface is now **1,333 chars** on the wire, against ~5,900
for the six. `room_id` is gone from the schema entirely (the extension fills it
from `lastInbound`), and `message_id` defaults the same way for the two actions
that target the message being answered.

The trade is one extra hop for the five uncommon actions — and none at all for
the common one, because an ordinary written answer is forwarded with no tool call
at all. `tests/tool-budget.test.ts` asserts this against the wire rather than the
source, with a control (pi's own `bash` present in both runs) so an empty capture
cannot pass as a pass, and prints the measured size so a regression is visible
rather than inferred.

## Two known hazards

- **One channel per machine, one account per channel.** Two bots signed into the
  same Matrix account duplicate every delivery and fight over the crypto store,
  which ends with a bot that cannot decrypt its own rooms. If a Claude Code
  prinny channel is also set up here, give this one its own Matrix account — the
  state directories are already separate, but the homeserver cares about the
  account.
- **The sidecar is not restarted automatically when it exits.** It retries the
  *homeserver* forever on its own, so an exit means something a restart loop
  cannot fix: bad credentials, a broken build, a killed process. Looping on that
  would spawn a process a second. `/prinny start` is the retry.

## Tests

```
cd vendor/prinny-channel
node vendor/prinny-channel/server/bin/prinny-channel.mjs --prepare   # once, ~1 min
node --experimental-strip-types --test tests/*.test.ts
```

231 tests, no `node_modules`, three layers:

- **Upstream's suite** (access, queue, inbox, mentions, permissions, history,
  stdout guard) ported from vitest onto `node:test` via `tests/harness.ts`, and
  run against the *compiled* sidecar — the artifact that actually ships. The
  harness re-imports from a fresh copy of `dist` per generation, because a query
  string only busts the module it is on and these modules capture their paths
  from a sibling.
- **The pi side**: the MCP client driven against a real child process that can be
  told to split messages mid-JSON, print prose onto the transport, go silent, or
  die; plus the forwarding filter, the gate, the block renderer and the access
  mutations.
- **End to end**: the extension inside a real `pi --mode json` process, with
  `PRINNY_SIDECAR_ENTRY` pointed at a stand-in that speaks the protocol without
  needing a homeserver. This is what catches a wrong notification method name,
  which otherwise fails as "messages never arrive" and nothing else.

Two findings worth keeping:

- `constructor(private readonly x: T)` is TypeScript that emits code, and Node's
  strip-only type stripping rejects it. pi's loader copes, so it would have run
  under pi and failed only under `node --test`.
- Node does **not** rewrite a `.js` specifier to `.ts`, so the sidecar's sources
  cannot be imported directly — checked with a control, not assumed.
