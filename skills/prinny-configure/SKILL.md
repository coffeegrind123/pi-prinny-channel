---
name: prinny-configure
description: Set up the Matrix channel for pi — save the homeserver, bot account and password, build the channel runtime, and get the first person paired. Use when the user pastes Matrix bot credentials, asks to configure prinny or Matrix, asks how to set up talking to pi from their phone, or reports that the bot never answers.
---

# Setting up the Matrix channel

Three things have to be true before a Matrix message reaches this session:
credentials are saved, the runtime is built, and at least one person is on the
allowlist. `/prinny` tells you which of them are missing — start there, every
time.

**All of it goes through `/prinny`.** Do not write `.env` or `access.json`
yourself: the command merges credentials rather than replacing the file, which
matters because the channel stores the access token and device ID it mints for
itself in there.

## 1. Credentials

```
/prinny configure <homeserver> <@user:server> <password>
```

The three arguments are accepted in any order. Give the homeserver with its
scheme (`https://matrix.example.org`) — without one it has to be guessed apart
from the password. The user ID must be the full `@name:server` form; a bare name
does not say which server.

This saves to `<state-dir>/.env` at mode 600, builds the runtime if it has not
been built, and starts the channel.

**Keep the password.** It looks redundant once a token exists, and it is not:
cross-signing needs user-interactive auth, and without it modern clients treat
the bot as unverified-by-its-own-user and exclude it from end-to-end key
sharing. The symptom is a bot that appears to ignore people, with nothing in any
log. The channel logs in with the password once, stores the token it mints, and
stops logging in after that.

To use a token minted out of band instead: `/prinny configure token <token>` —
the caveat above still applies. To remove credentials: `/prinny configure clear`
(it leaves the allowlist alone; that is not a credential).

## 2. The runtime

The Matrix layer — matrix-js-sdk and its Rust crypto module, about 105MB — is
installed and compiled **outside the repository**, under the channel's state
directory. `/prinny configure` does it for you; to do it on its own:

```
/prinny prepare
```

It takes about a minute the first time. Say so before running it, so a long
pause reads as expected rather than as a hang. It is idempotent and keyed on a
hash of the payload source, so running it again on an unchanged tree returns
immediately.

If it fails, read the error rather than retrying — it names the cause:

- *"@prinny/bot installed but has no build output"* — the dependency is a git
  package whose build script has not been published. Point `PRINNY_BOT_PATH` in
  `<state-dir>/.env` at a local checkout of `prinny-bot`.
- *npm install failed* — usually no network, or a proxy. The message includes
  the directory to run it in by hand.

## 3. The first person

With the policy still on `pairing`, the user messages the bot from their Matrix
client and gets a six-character code back. Then:

```
/prinny pair <code>
```

Then **lock it down** — offer this without being asked:

```
/prinny policy allowlist
```

While the policy is `pairing`, any stranger who learns the bot's Matrix ID gets
a pairing code back, which confirms something is listening. `pairing` is how you
capture the first Matrix ID, not where you leave it.

## What good looks like

`/prinny` reporting `connected`, credentials set, runtime built, policy
`allowlist`, and at least one Matrix ID allowed. At that point a message from
that ID becomes a turn in this session, and the answer comes back automatically.

## When it does not answer

Work down this list; each item is silent on its own.

1. `/prinny` — is the channel `connected`? If it says *not configured* or *NOT
   BUILT*, that is the answer.
2. `/prinny log 100` — the channel's own log. The sidecar reports here because
   it cannot write to the terminal without corrupting pi's display. A homeserver
   that is unreachable appears here as a retry line and nowhere else.
3. Is the sender on the allowlist, and is the policy not `disabled`? A message
   from an unknown sender is dropped silently and deliberately — reporting it
   would confirm to a stranger that something is listening.
4. In a shared room: is the room enabled at all (`/prinny room add`), and does
   the message mention the bot? Rooms require a mention unless added with
   `--no-mention`.
5. Encrypted room, everything else fine → the cross-signing problem above.
   Configure with a password once and restart.

## Second bot on the same account

Don't. Two bots signed into one Matrix account with the same device duplicate
every delivery and fight over the crypto store, which ends with a bot unable to
decrypt its own rooms. If a Claude Code prinny channel is also configured on
this machine, give this one **its own Matrix account**, not just its own state
directory — the state directories are already separate (`~/.pi/agent/channels/`
versus `~/.claude/channels/`), but the account is what the homeserver cares
about.
