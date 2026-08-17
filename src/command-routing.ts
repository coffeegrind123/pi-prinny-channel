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
  compact: null,
  stack: null,
  loop: null,
};

/**
 * Flags that would route around a refusal elsewhere in this table.
 *
 * `/loop run --model M` and `/loop prepare --model M` switch the model
 * (`switchModel` in vendor/pi-loop-mode). `/model` is refused from Matrix
 * because it changes what the operator is paying for and how it behaves, so
 * reaching the same switch through a permitted command is a side door, not a
 * feature. Refused on the flag, which is the thing that was actually decided
 * against — not on the subcommand, which is useful.
 */
export const REFUSED_FLAGS: readonly string[] = ['--model'];

export type MatrixCommand =
  | { kind: 'text' }
  | { kind: 'run'; name: string; text: string }
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

  if (!Object.prototype.hasOwnProperty.call(MATRIX_ALLOWED, name)) {
    return {
      kind: 'refuse',
      name,
      reason: `/${name} cannot be run from Matrix. Run it in the terminal.`,
    };
  }

  const smuggled = REFUSED_FLAGS.find((flag) => new RegExp(`(^|\\s)${flag}(=|\\s|$)`).test(rest));
  if (smuggled) {
    return {
      kind: 'refuse',
      name,
      reason:
        `${smuggled} cannot be set from Matrix — it changes the model for the whole session. ` +
        `Run /${name} without it, or set the model in the terminal.`,
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
