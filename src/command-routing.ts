/**
 * Which pi commands a Matrix sender may run, and what happens to the rest.
 *
 * ## The door this opens, and why it was shut
 *
 * `sendUserMessage()` calls pi's `prompt()` with `expandPromptTemplates: false`,
 * and the command branch there is `if (expandPromptTemplates && text.startsWith("/"))`.
 * So a Matrix message beginning with `/` has never executed anything — it
 * reaches the model as literal text. That default is the reason a channel
 * exposed to the internet has not, so far, been a way to drive the harness.
 *
 * Passing `expandPromptTemplates: true` opens it. This module decides for which
 * commands, and the answer is a short allowlist rather than a blocklist, because
 * the failure modes are not symmetric: forgetting to allow something costs a
 * message saying "run that in the terminal", and forgetting to deny something
 * hands an allowlisted Matrix account the harness.
 *
 * ## What is denied, and why each one
 *
 * Not denied, and worth saying because an earlier version got it wrong:
 * `/loop start` and `/loop run`. They were refused as "handing over the
 * machine", which does not survive inspection — an allowlisted sender can
 * already direct arbitrary work in prose. Only the `--model` flag on them is
 * refused, because `/model` is refused below and a permitted command must not
 * become a side door to it.
 *
 *   prinny   edits the allowlist itself — the escalation from "can message the
 *            bot" to "can decide who may message the bot". This is the exact
 *            request a prompt injection makes, and the sidecar's own
 *            instructions already tell the model to refuse it; now it does not
 *            depend on the model choosing to.
 *   trust    grants project trust, which loads that project's extensions —
 *            arbitrary code, one message away.
 *   login    credentials.
 *   logout
 *   settings can change the model, the thinking level and compaction sizing.
 *   share    publishes the session. The operator's local work is in it.
 *   export
 *   copy
 *   new      moves the operator to a different conversation, or ends theirs.
 *   fork
 *   resume
 *   session
 *   tree
 *   quit
 *   model    changes what the operator is paying for and how it behaves.
 *   name     harmless, but there is no reason to spend the allowlist on it.
 *   agents   an interactive TUI menu. Nothing it does can happen over Matrix,
 *            and it was missing from KNOWN_COMMANDS entirely (AD5, thirteenth
 *            pass) — so it was neither allowed nor refused but delivered as
 *            PROSE, spending a model call on text the model cannot act on and
 *            leaving the sender with an answer about a menu nobody opened.
 *            Every other command this stack registers was in the table.
 *
 * Anything that is not a recognised pi command is left alone and delivered as
 * ordinary text — "/usr/bin/foo is broken" is a sentence, not an instruction.
 */

/** Every command this stack registers, used to tell a refused command from prose. */
export const KNOWN_COMMANDS: readonly string[] = [
  // pi built-ins
  'compact',
  'copy',
  'export',
  'fork',
  'login',
  'logout',
  'model',
  'name',
  'new',
  'quit',
  'resume',
  'session',
  'settings',
  'share',
  'tree',
  'trust',
  // this repo's extensions
  'agents',
  'loop',
  'prinny',
  'stack',
];

/**
 * What a Matrix sender may run. `null` means the whole command.
 *
 * `/loop` is allowed in full, including `start` and `run`. An earlier version
 * refused those on the grounds that starting an unattended run was "handing over
 * the machine", and that reasoning does not survive inspection: an allowlisted
 * sender can already direct arbitrary work in prose — bash, edits, anything —
 * subject only to the permission gate. The boundary is the allowlist, not the
 * command surface, and refusing `start` protected nothing that a sentence could
 * not already do.
 *
 * What IS true of a loop is that it keeps acting after the sender stops
 * messaging, which no prose can arrange because the model cannot invoke a
 * command. That is a blast-radius and cost property, not a security one, and it
 * is the operator's call rather than this file's — `/loop stop` is one message
 * away from the same phone.
 */
export const MATRIX_ALLOWED: Readonly<Record<string, readonly string[] | null>> = {
  stack: null,
  loop: null,
};

/**
 * Commands this extension performs ITSELF, because pi will not.
 *
 * Twelfth pass (AC5), and the reason it is a separate table rather than a third
 * entry above. `sendUserMessage` reaches `AgentSession.prompt()`, whose command
 * branch is `_tryExecuteExtensionCommand` — `this._extensionRunner.getCommand(name)`,
 * i.e. **extension** commands only. In this stack that is `/stack`, `/loop`,
 * `/agents` and `/prinny`, and nothing else. `/compact` is one of pi's BUILT-IN
 * slash commands (`core/slash-commands.js`), and the only thing that executes one
 * is the TUI's own input handler (`modes/interactive/interactive-mode.js`, the
 * `text === "/compact"` branch). Nothing reachable from here.
 *
 * So `/compact` was on the allow-list above, advertised in the Matrix client's
 * command menu, and could not work: `prompt()` found no extension command, fell
 * through, and delivered the literal text `/compact` to the model as a user
 * turn — a whole model call on the one llama slot, spent on a message the model
 * cannot act on — while the sender was told "Ran `/compact`. Its output stays in
 * the terminal." The room never went live either (the echoed text is the command,
 * not the `<channel>` block `markLive` matches), so the answer was never
 * forwarded and, before AC4, the sweep then reported the message as undelivered.
 *
 * `ExtensionContext.compact(options)` exists and is exactly this operation, so
 * the command is kept and performed properly instead of being withdrawn. The
 * split is the durable part: an entry here is a promise THIS FILE keeps, an entry
 * above is a promise pi keeps, and putting a built-in in the wrong table is the
 * mistake that was made.
 */
export const MATRIX_LOCAL: Readonly<Record<string, string>> = {
  compact: "compact the conversation context",
};

/**
 * Flags that would route around a refusal elsewhere in this table, or around
 * the permission relay.
 *
 * `/loop run --model M` and `/loop prepare --model M` switch the model
 * (`switchModel` in vendor/pi-loop-mode). `/model` is refused from Matrix
 * because it changes what the operator is paying for and how it behaves, so
 * reaching the same switch through a permitted command is a side door, not a
 * feature. Refused on the flag, which is the thing that was actually decided
 * against — not on the subcommand, which is useful.
 *
 * ## Thirteenth pass — the two that were missed, and they are not the same kind
 *
 * **`--rescue-model` (AD7)** is the same door with a different handle.
 * `interveneStuck()` calls `switchModel(pi, ctx, state.rescueModel)` at the
 * third consecutive stuck turn, so the flag switches the operator's session
 * model exactly as `--model` does — just later, and only if the run gets stuck,
 * which is a worse property rather than a better one. The `--model` guard could
 * not catch it: its pattern needs whitespace before the flag, and
 * `--rescue-model` has `e-` there.
 *
 * **`--check` (AD6)** is a different thing altogether, and it is the reason this
 * table exists. The header above justifies allowing `/loop` in full on the
 * grounds that "an allowlisted sender can already direct arbitrary work in prose
 * — bash, edits, anything — **subject only to the permission gate**". That last
 * clause is what makes the argument work, and `--check` is the one argument on
 * the allowed surface it is not true of: the value is stored in `LoopState` and
 * run by `runGoalCheck` as `pi.exec("bash", ["-lc", wrapCheckCommand(cmd)])`,
 * once per iteration for the life of the run and across `/loop resume`. `pi.exec`
 * is `execCommand`; it emits no `tool_call`, so this extension's own permission
 * relay — a `tool_call` handler — never sees it, `rtk-pi`'s gate never sees it,
 * and `compaction-guard`'s output cap never sees it. The identical string sent
 * as prose becomes a `bash` tool call and IS gated. One string, two doors, one
 * of them unwatched.
 *
 * A goal check is worth having, so this refuses the flag rather than the
 * subcommand: `/loop start <goal>` from Matrix still works, and the operator can
 * attach a check in the terminal, where they are the one choosing the command.
 *
 * Measured: `context/testing/probes/q4-what-a-leading-slash-from-matrix-can-do.mjs`.
 */
export const REFUSED_FLAGS: readonly string[] = ['--model', '--rescue-model', '--check'];

/**
 * Why each refused flag is refused, so the sender is told the actual reason
 * rather than a sentence about the model that is wrong for two of the three.
 */
const REFUSED_FLAG_REASONS: Readonly<Record<string, string>> = {
  '--model': 'it changes the model for the whole session',
  '--rescue-model': 'it switches the session model as soon as the run gets stuck',
  '--check': 'its value is run as a shell command every iteration, and that one does not pass the permission relay',
};

export type MatrixCommand =
  | { kind: 'text' }
  | { kind: 'run'; name: string; text: string }
  /** Performed by this extension, not by pi. See MATRIX_LOCAL. */
  | { kind: 'local'; name: string; text: string }
  | { kind: 'refuse'; name: string; reason: string };

/**
 * Decide what an inbound Matrix body is.
 *
 * Only the first line is considered a candidate: a message whose second
 * paragraph happens to start with a slash is prose, and running it would be a
 * surprise.
 */
export function classifyMatrixCommand(body: unknown): MatrixCommand {
  if (typeof body !== 'string') return { kind: 'text' };
  const trimmed = body.trim();
  if (!trimmed.startsWith('/')) return { kind: 'text' };
  // A command is one line. Anything else is a message that opens with a slash.
  if (/\r?\n/.test(trimmed)) return { kind: 'text' };

  const match = /^\/([a-zA-Z][\w-]*)\s*(.*)$/.exec(trimmed);
  if (!match) return { kind: 'text' };
  const name = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').trim();

  if (!KNOWN_COMMANDS.includes(name)) return { kind: 'text' };

  // Before the allow-list, because a local command is not something pi is being
  // asked to do and the flag check below is about pi's commands.
  if (Object.prototype.hasOwnProperty.call(MATRIX_LOCAL, name)) {
    return { kind: 'local', name, text: trimmed };
  }

  if (!Object.prototype.hasOwnProperty.call(MATRIX_ALLOWED, name)) {
    return {
      kind: 'refuse',
      name,
      reason: `/${name} cannot be run from Matrix. Run it in the terminal.`,
    };
  }

  // Longest first, so `--rescue-model` is named as itself rather than being
  // reported under a flag it merely contains. (The patterns are anchored on
  // whitespace and cannot actually overlap today; the ordering is here so that
  // adding `--check-timeout` next to `--check` does not quietly misreport.)
  const smuggled = [...REFUSED_FLAGS]
    .sort((a, b) => b.length - a.length)
    .find((flag) => new RegExp(`(^|\\s)${flag}(=|\\s|$)`).test(rest));
  if (smuggled) {
    return {
      kind: 'refuse',
      name,
      reason:
        `${smuggled} cannot be set from Matrix — ${REFUSED_FLAG_REASONS[smuggled] ?? 'it is not safe to set from here'}. ` +
        `Run /${name} without it, or set it in the terminal.`,
    };
  }

  const allowedArgs = MATRIX_ALLOWED[name];
  if (allowedArgs === null) return { kind: 'run', name, text: trimmed };

  const first = (rest.split(/\s+/)[0] ?? '').toLowerCase();
  if (allowedArgs.includes(first)) return { kind: 'run', name, text: trimmed };
  return {
    kind: 'refuse',
    name,
    reason:
      `/${name} ${first || '(no argument)'} cannot be run from Matrix. ` +
      `Allowed here: ${allowedArgs.map((arg) => `/${name} ${arg}`).join(', ')}.`,
  };
}

/** The commands worth advertising in a client's `/` menu, in menu order. */
export function advertisedCommands(): { command: string; description: string }[] {
  return [
    { command: 'help', description: 'What this bot can do' },
    { command: 'status', description: 'Check your pairing status' },
    { command: 'compact', description: 'Compact the conversation context' },
    { command: 'stack', description: 'Show local model stack status' },
    { command: 'loop', description: 'Loop: goal, prepare, run, start, status, stop, finish' },
  ];
}
