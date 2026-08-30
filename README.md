# pi-prinny-channel

Talk to a [pi](https://pi.dev) session — and the local model behind it — from any
Matrix client. A message from an allowlisted sender becomes a turn; the answer
comes back to the room by itself.

[![CI](https://github.com/coffeegrind123/pi-prinny-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/coffeegrind123/pi-prinny-channel/actions/workflows/ci.yml)

Converted from the Claude Code plugin of the same name
([coffeegrind123/prinny-channel](https://github.com/coffeegrind123/prinny-channel)).
The Matrix half is upstream's; everything that touched Claude Code was rewritten
for pi. `FORK.md` is the full account — it is long, and it is long because each
section is an incident.

## Install

```bash
pi install git:github.com/coffeegrind123/pi-prinny-channel@v1.0.0
```

Then, once:

```
/prinny prepare                                     ~1 min, builds the sidecar
/prinny configure https://matrix.example.org @bot:matrix.example.org <password>
# message the bot from your Matrix client — it replies with a code
/prinny pair <code>
/prinny policy allowlist                            stop handing out codes
```

`/prinny` on its own prints connection state, policy, allowlist, pending pairings
and settings. `/prinny log` tails the channel's own log — the channel never
writes to the terminal, because in pi stdout and stderr are the TUI.

## How it is put together

The Matrix layer runs as a **child process**, not inside pi. Loading
matrix-js-sdk plus its Rust crypto blocks the event loop for ~15 seconds and
writes to stdout on the way up; in-process that is a frozen TUI drawn over with
library chatter. Its ~105 MB of dependencies are installed outside your repo, at
`~/.pi/agent/channels/prinny/runtime`, by `/prinny prepare`.

That runtime is a compiled copy of `server/src`, keyed on a content fingerprint,
so it can be out of date. Everything that asks says which of three states it is
in — `current`, `stale`, `absent` — and `/prinny start` refuses on `stale` rather
than starting, because a stale runtime re-stages inside a 120-second connect
budget and fails as `initialize timed out`, which reads as a broken channel
rather than a rebuild.

## Delivery

```
/prinny forward all      every assistant message as it completes (default)
/prinny forward result   the whole turn, in order, as one message when it settles
/prinny forward last     only the turn's closing text
/prinny forward off      nothing unless the model calls the prinny tool

/prinny set deliverAs steer      an inbound message lands mid-run (default)
/prinny set deliverAs followUp   it waits for the agent to finish every tool call
```

**Only assistant `text` is ever forwarded** — thinking blocks and tool calls
never are, in any mode. The filter is an allowlist on `type === "text"`, so a
content kind a future pi adds is excluded by default rather than leaked.

**The answer is forwarded, not requested.** Upstream made a `reply` tool the only
way out, which holds at frontier scale and does not at 27B: the model writes a
good answer into the transcript, never calls the tool, and the person on Matrix
sees nothing while the operator sees a complete reply.

## Wearing the persona

With [pi-persona](https://github.com/coffeegrind123/pi-persona) installed, the
bot takes the active persona's name and the card's image as its Matrix display
name and avatar, so the person on the other end sees who they are talking to
rather than a bot called `pi`. Clearing the persona puts the original name back.

```
/prinny set personaProfile off    # stop mirroring; default is on
```

The persona files are read off disk rather than imported — the two packages do
not depend on each other, and the tests assert they still agree about the file
names and the framing sentence.

## Wearing the persona's profile

With a persona active the bot takes its name and the card's image, advertises a
short description, and fills in the **About Me** on its profile card — the last
in first person, because that box is what every account fills in about itself.
Written once by pi-persona's extraction turn, published in one sync.

## The status bubble

The bot's Matrix status message follows what the session is doing — `thinking…`,
`reading src/prompt.ts`, `$ npm test`, `browsing example.com` — and clears when
the run settles. Driven from the turn lifecycle, so it costs no tokens and the
model is not involved.

```
/prinny set presenceStatus off    # stop publishing it; default is on
```

Presence is rate-limited by the homeserver (measured: writes land about once
every 8 seconds), so updates are coalesced — at most one write per 12s, always
the latest value, and a refusal is retried with whatever the status is by then
rather than with the value that was refused.

## Being present, with a persona

With [pi-persona](https://github.com/coffeegrind123/pi-persona) active, the
character can act on the room itself:

```
prinny(action: "status", { text })    the line under your name — one per 10 min
prinny(action: "topic",  { topic })   the room's subject — one per hour
```

Both are rate limited **in code**, not by asking the model nicely, and a call
inside the window is refused with a sentence that says the refusal is normal so
it does not get retried or apologised for. The system-prompt nudge appears only
when a persona is active *and* the channel is running, and its loudest sentence
is that doing neither is the normal case.

A status the persona sets outlives the run: the automatic activity line shows
while the session works, then falls back to the character's own line rather than
clearing.

## Permissions

`/prinny permissions <off|dangerous|all>` relays tool calls to Matrix for
approval. Off by default: pi has no built-in approval prompt, so adding friction
it does not otherwise have would be a surprise rather than a feature.

## Tests

```bash
npm run lint
npm run test:unit      # no network, no Matrix
npm run prepare-runtime && npm test   # adds the e2e suite
```

## Security

It logs a bot into a homeserver and makes a coding session addressable from the
internet. Read `FORK.md`'s access and permission sections before pointing it at
anything you care about, and prefer `/prinny policy allowlist` once you have
paired the people you meant to.

## License

MIT.
