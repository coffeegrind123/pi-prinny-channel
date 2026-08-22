/**
 * Which tool calls get relayed to Matrix for approval.
 *
 * In Claude Code this file has no counterpart: the harness raises its own
 * permission prompts and the channel merely carries them. pi has no such
 * prompt — a trusted project's tools run — so the extension has to be the thing
 * that decides, and "decide" has to be written down rather than inherited.
 *
 * The point of the feature in pi is remote driving: when the operator is
 * answering from Matrix, pi's TUI confirmations are on a screen nobody is
 * looking at. A gate that reaches them where they actually are is the only
 * approval that can be given at all.
 *
 * Default mode is `off`. Turning it on is a deliberate act, because a gate the
 * operator forgets they enabled looks exactly like a hung agent.
 */

import type { PermissionMode, PiSettings } from './config.ts';

/** Tools that touch the world rather than read it. Gated under `all`. */
const MUTATING_TOOLS = new Set(['bash', 'edit', 'write']);

/**
 * Commands worth a second opinion, under `dangerous`.
 *
 * Each entry names what it is guarding, because a bare regex list rots into
 * something nobody dares change. These are matched against the whole command
 * string, so a pipeline is caught wherever the risky part sits in it.
 *
 * ## Why three of these are functions and not regexes (AK2, twentieth pass)
 *
 * A regex over the raw string tests a SPELLING. Three of these guard a
 * PROPERTY — "this deletes a tree", "this throws away the working tree", "this
 * makes something world-writable" — and the property has more spellings than
 * the regex had. Measured against the shipped module, with `permissionMode`
 * set to `dangerous`, i.e. an operator who has said *ask me before this*:
 *
 * ```
 *   rm -rf /tmp/x                GATE      the one spelling it knew
 *   rm -rfv /tmp/x               PASS  ✘   any flag letter AFTER the f defeats
 *                                          the trailing \b — and -v on an rm is
 *                                          not exotic, it is what you add when
 *                                          you want to see what went
 *   rm -r -f /tmp/x              PASS  ✘   the cluster has to be one token
 *   rm --recursive --force x     PASS  ✘   the long spelling was never in it
 *   rm /tmp/x -rf                PASS  ✘   GNU rm takes flags after the path
 *   git clean --force -d         PASS  ✘   `clean -[a-z]*[fd]` is short-form only
 *   chmod 0777 /etc              PASS  ✘   `777\b` is not preceded by \b, but the
 *                                          pattern anchors it to the token start
 * ```
 *
 * `/prinny permissions` describes this mode to the operator as
 * *"ask on Matrix before rm -rf, sudo, force push, curl|sh, and similar"* — and
 * "and similar" is the whole promise. Four ordinary spellings of the FIRST
 * example were not similar enough.
 *
 * So the three that are about a property now read the command's tokens and ask
 * the question directly: does an `rm` in here carry both recursion and force,
 * however either is written. The rest stay regexes, because they genuinely are
 * about a spelling (`npm publish`, `mkfs`, `> /dev/sd…`) and a token walk would
 * add nothing but a second thing to get wrong.
 *
 * The direction of every judgement call below is *ask*, never *skip*: an
 * over-asked prompt costs one tap, and this is the module whose whole reason to
 * exist is that the decision belongs to a person. `git clean -n` (a dry run
 * that deletes nothing) still does not gate, only because it did not before and
 * silence about a no-op is not the failure this is fixing.
 */

/**
 * Split a command line into the individual commands it will actually run.
 *
 * Crude on purpose: `;`, `&&`, `||`, `|`, `&`, newline and the openers of a
 * substitution all end a command. Getting this wrong in the direction of TOO
 * MANY segments is free — each is scanned independently and a false segment
 * matches nothing — while getting it wrong the other way hides a command.
 */
function segmentsOf(command: string): string[] {
  return command.split(/(?:\|\||&&|[|;&\n]|\$\(|`|\))+/g).filter((part) => part.trim() !== '');
}

/** Strip one layer of surrounding quotes from a token. */
function unquote(token: string): string {
  const match = /^(['"])([\s\S]*)\1$/.exec(token);
  return match ? match[2]! : token.replace(/^['"]|['"]$/g, '');
}

/**
 * Leading things that are not the command: environment assignments, and the
 * wrappers that take one. `sudo` is here as well as in its own pattern —
 * `sudo rm -rf x` is caught twice and reported once, by whichever entry comes
 * first, and both sentences are true.
 */
const ARGV0_SKIP = /^(?:[A-Za-z_][A-Za-z0-9_]*=|sudo$|doas$|env$|nice$|time$|timeout$|nohup$|xargs$|command$|builtin$)/;

/**
 * Tokens after which the REST of the line is another command.
 *
 * `find . -exec rm -rf {} +` is the shape this exists for, and it is the one
 * case where the old raw-string regex was strictly better than a naive token
 * walk: it never had to know what `-exec` means, because it never looked at
 * argv0 at all. Losing that would have been a regression dressed as a fix, so
 * the walk is told about the handful of tokens that introduce a command.
 */
const COMMAND_INTRODUCERS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-c', 'exec', 'then', 'do', 'else']);

/**
 * Every command in `line`, as argv-ish token lists, including the ones nested
 * inside a quoted `-c` argument.
 *
 * `bash -c "rm -rf /tmp/x"` is the shape that matters: the old regex caught it
 * only because it scanned the raw string, and a token walk that stopped at the
 * quote would have been a regression. So any token that still contains
 * whitespace after unquoting is scanned again as a command line of its own,
 * to a fixed depth.
 */
function commandsIn(line: string, depth = 0): string[][] {
  if (depth > 3) return [];
  const out: string[][] = [];
  for (const segment of segmentsOf(line)) {
    const raw = segment.trim().split(/\s+/).filter(Boolean);
    const tokens = raw.map(unquote);
    let start = 0;
    while (start < tokens.length && ARGV0_SKIP.test(tokens[start]!)) start++;
    if (start < tokens.length) out.push(tokens.slice(start));
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (COMMAND_INTRODUCERS.has(token) && i + 1 < tokens.length) out.push(tokens.slice(i + 1));
      if (/\s/.test(token) && token !== segment.trim()) out.push(...commandsIn(token, depth + 1));
    }
  }
  return out;
}

/** The program a token list runs, with any directory prefix removed. */
function argv0(tokens: readonly string[]): string {
  return (tokens[0] ?? '').split('/').pop() ?? '';
}

/**
 * Read a command's flags, short letters and long names alike, stopping at `--`.
 *
 * Everything after `--` is an operand by POSIX convention, so `rm -- -rf` is a
 * request to delete a FILE called `-rf` and must not read as a recursive force
 * delete. That was already true of the regex, by accident; it is true here on
 * purpose.
 */
function flagsOf(tokens: readonly string[]): { letters: Set<string>; long: Set<string>; operands: string[] } {
  const letters = new Set<string>();
  const long = new Set<string>();
  const operands: string[] = [];
  let ended = false;
  for (const token of tokens.slice(1)) {
    if (ended) {
      operands.push(token);
      continue;
    }
    if (token === '--') {
      ended = true;
      continue;
    }
    if (/^--[A-Za-z][\w-]*/.test(token)) {
      long.add(token.slice(2).split('=')[0]!.toLowerCase());
      continue;
    }
    if (/^-[A-Za-z]+$/.test(token)) {
      for (const letter of token.slice(1)) letters.add(letter);
      continue;
    }
    operands.push(token);
  }
  return { letters, long, operands };
}

/** `rm` that carries both recursion and force, in any spelling. */
function isRecursiveForceDelete(command: string): boolean {
  for (const tokens of commandsIn(command)) {
    if (argv0(tokens) !== 'rm') continue;
    const { letters, long } = flagsOf(tokens);
    const recursive = letters.has('r') || letters.has('R') || long.has('recursive');
    const force = letters.has('f') || long.has('force');
    if (recursive && force) return true;
  }
  return false;
}

/** `git reset --hard` and `git clean` with force or directory removal, in any order. */
function isWorkingTreeDiscard(command: string): boolean {
  for (const tokens of commandsIn(command)) {
    if (argv0(tokens) !== 'git') continue;
    const sub = tokens.slice(1).find((token) => !token.startsWith('-'));
    if (sub !== 'reset' && sub !== 'clean') continue;
    const { letters, long } = flagsOf(tokens);
    if (sub === 'reset') {
      if (long.has('hard')) return true;
      continue;
    }
    if (letters.has('f') || long.has('force') || letters.has('d') || long.has('directory')) return true;
  }
  return false;
}

/**
 * `chmod` granting write to everyone.
 *
 * Octal: the last three digits are user/group/other and the write bit is 2, so
 * any mode whose OTHER digit has it — 777, 0777, 666, 707 — is world-writable.
 * Symbolic: an `o` or `a` (or a bare `+w`, which honours umask but is the same
 * intent) that adds `w`.
 */
function isWorldWritableChmod(command: string): boolean {
  for (const tokens of commandsIn(command)) {
    if (argv0(tokens) !== 'chmod') continue;
    const { operands } = flagsOf(tokens);
    const mode = operands[0];
    if (!mode) continue;
    const octal = /^[0-7]{3,4}$/.exec(mode);
    if (octal) {
      const other = Number.parseInt(mode.slice(-1), 8);
      if ((other & 2) !== 0) return true;
      continue;
    }
    if (/(^|,)[ugoa]*[+=][A-Za-z]*w/.test(mode) && /(^|,)(a|o|[+=])/.test(mode)) return true;
  }
  return false;
}

export interface DangerCheck {
  /** What it is guarding, shown to the approver. */
  what: string;
  /** True when this command line has the property. */
  test: (command: string) => boolean;
}

const DANGEROUS_CHECKS: DangerCheck[] = [
  { what: 'recursive force delete', test: isRecursiveForceDelete },
  { what: 'privilege escalation', test: (c) => /\bsudo\b|\bdoas\b/.test(c) },
  {
    what: 'piping a download into a shell',
    test: (c) => /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/.test(c),
  },
  { what: 'writing to a block device', test: (c) => /\bdd\b[^|;&]*\bof=\s*\/dev\//.test(c) },
  { what: 'formatting a filesystem', test: (c) => /\bmkfs(\.[a-z0-9]+)?\b/.test(c) },
  {
    what: 'force push',
    test: (c) => /\bgit\s+push\b[^|;&]*(--force\b(?!-with-lease)|(?<![\w-])-f(?![\w-]))/.test(c),
  },
  { what: 'discarding working-tree changes', test: isWorkingTreeDiscard },
  { what: 'publishing a package', test: (c) => /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/.test(c) },
  { what: 'powering the machine down', test: (c) => /\b(shutdown|reboot|halt|poweroff)\b/.test(c) },
  { what: 'making something world-writable', test: isWorldWritableChmod },
  { what: 'destroying docker state', test: (c) => /\bdocker\s+(system\s+prune|volume\s+rm)\b/.test(c) },
  { what: 'deleting cluster resources', test: (c) => /\b(kubectl|helm)\s+delete\b/.test(c) },
  { what: 'destroying evidence of what ran', test: (c) => /\bhistory\s+-c\b|\bshred\b/.test(c) },
  { what: 'redirecting onto a disk', test: (c) => />\s*\/dev\/sd[a-z]/.test(c) },
];

/** Exposed so a test can name every guard rather than counting them. */
export const DANGEROUS_WHATS: readonly string[] = DANGEROUS_CHECKS.map((check) => check.what);

export type GateDecision =
  | { gate: false }
  /** `reason` is shown to the approver, so it says what is risky, not that something is. */
  | { gate: true; reason: string };

/** The command a tool call would run, when the tool runs commands. */
function commandOf(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName !== 'bash') return undefined;
  const command = input.command;
  return typeof command === 'string' ? command : undefined;
}

export function needsApproval(
  toolName: string,
  input: Record<string, unknown>,
  settings: Pick<PiSettings, 'permissionMode' | 'permissionTools'>
): GateDecision {
  // An explicitly listed tool is gated whatever the mode says — including when
  // the mode is `off`, because naming a tool is a more specific instruction
  // than choosing a mode.
  if (settings.permissionTools.includes(toolName)) {
    return { gate: true, reason: `${toolName} is on the always-ask list` };
  }

  const mode: PermissionMode = settings.permissionMode;
  if (mode === 'off') return { gate: false };

  if (mode === 'all') {
    if (MUTATING_TOOLS.has(toolName)) return { gate: true, reason: `${toolName} changes the machine` };
    return { gate: false };
  }

  // mode === "dangerous"
  const command = commandOf(toolName, input);
  if (command === undefined) return { gate: false };
  for (const { test, what } of DANGEROUS_CHECKS) {
    if (test(command)) return { gate: true, reason: what };
  }
  return { gate: false };
}

/**
 * A one-line, readable summary of what a tool call would do.
 *
 * Shown in the Matrix prompt above the buttons. It has to be short enough to
 * read on a phone and specific enough to decide on — an approval prompt that
 * only names the tool is a prompt that gets approved without being read.
 */
export function describeCall(toolName: string, input: Record<string, unknown>): string {
  const command = commandOf(toolName, input);
  if (command !== undefined) return truncate(command.replace(/\s+/g, ' ').trim(), 300);
  const path = input.path ?? input.file_path ?? input.filePath;
  if (typeof path === 'string') return `${toolName} ${truncate(path, 200)}`;
  return toolName;
}

/** The full arguments, for the "See more" expansion. */
export function previewCall(input: Record<string, unknown>): string {
  try {
    return truncate(JSON.stringify(input, null, 2), 4_000);
  } catch {
    return truncate(String(input), 4_000);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The request id the sidecar's reply parser expects.
 *
 * Five lowercase letters with `l` excluded, matching
 * `server/src/permissions.ts` — that regex is what turns a plain-text "y abcde"
 * from a client with no button support back into a decision, so an id outside
 * its alphabet would be answerable by button only, and only on some clients.
 */
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz';

export function newRequestId(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 5; i += 1) {
    id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  }
  return id;
}

/**
 * The key this extension stamps on a tool call a person has approved, and the
 * one `vendor/rtk-pi` reads before it rewrites anything.
 *
 * ## The two strings
 *
 * Nineteenth pass (AJ3). `tool_call` handlers run in load order over ONE mutable
 * `event.input`, and `scripts/pi-local.sh` loads this package before `rtk-pi` —
 * deliberately, with the reason written next to the `-e` flag:
 *
 * > So with prinny first, the command a person is asked to approve is the
 * > command the model wrote, and a blocked command is never handed to rtk at
 * > all. The other way round the relay would quote `rtk git status` for a model
 * > that asked for `git status`, which is an approval for a command nobody
 * > typed.
 *
 * Both halves of that are true, and the conclusion is one actor short. An
 * approval gate is not about the command that was REQUESTED, it is about the
 * command that will RUN — and `rtk-pi`'s handler runs after this one and
 * rewrites `event.input.command` in place. So the approver was shown
 * `git status`, said yes, and `rtk git status` is what pi's bash tool executed.
 * The other order is no better: it quotes a string the model never wrote and
 * spends a `rtk rewrite` subprocess on a call that is about to be blocked.
 *
 * The stack already has the mechanism for a handler to tell a LATER handler
 * something about the same call: `pi-subagents-lite`'s `toolCallListener` writes
 * `_resolvedAgent`, `model` and `thinking` onto this same object and
 * `executeAgentTool` reads them back. This is that, one package over, and one
 * key.
 *
 * ## What it means, and why it is only a boolean question
 *
 * The value is the exact text a person read — `describeCall`'s output, which is
 * what the Matrix prompt showed above the buttons. `rtk-pi` does not compare it:
 * the presence of the stamp is the whole signal, because "a person approved this
 * command as written" and "something may now rewrite it" cannot both be true.
 * Standing down costs an allow-listed command its output compression, in a
 * session that has explicitly turned the relay on, which is the trade that
 * session already chose.
 *
 * ## Why a duplicated string rather than an import
 *
 * The same reason the compaction lock is a `globalThis` key with three copies of
 * its protocol: vendor packages must not import each other. `rtk-pi` is a fork of
 * an upstream hook that knows nothing about Matrix. `tests/permission-gate.test.ts`
 * here and `tests/approved-command.test.ts` there each read the OTHER package's
 * source and assert the two literals agree, which is the arrangement
 * `compaction-lock.ts` already uses.
 *
 * Nothing about this can fail closed. No prinny, no stamp, and `rtk-pi` behaves
 * exactly as it did; no rtk, and the stamp is an unread key on an object pi
 * already ignores unknown keys on (`validateToolArguments` has already run by
 * the time any handler sees it).
 */
export const APPROVED_COMMAND_KEY = '_prinnyApprovedCommand';

/**
 * Record that a person approved this call, as written.
 *
 * Takes the input object the handler was given, which is the same reference pi
 * hands to `tool.execute` — see the header. `shown` is what the approver read,
 * so the stamp is evidence rather than a flag: a later reader can say WHICH
 * string was approved, not merely that something was.
 */
export function markApproved(input: Record<string, unknown>, shown: string): void {
  if (!input || typeof input !== 'object') return;
  input[APPROVED_COMMAND_KEY] = shown;
}
