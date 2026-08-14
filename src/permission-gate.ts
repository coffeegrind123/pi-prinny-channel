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
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\b/, what: 'recursive force delete' },
  { pattern: /\bsudo\b|\bdoas\b/, what: 'privilege escalation' },
  { pattern: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/, what: 'piping a download into a shell' },
  { pattern: /\bdd\b[^|;&]*\bof=\s*\/dev\//, what: 'writing to a block device' },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, what: 'formatting a filesystem' },
  { pattern: /\bgit\s+push\b[^|;&]*(--force\b(?!-with-lease)|(?<![\w-])-f(?![\w-]))/, what: 'force push' },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fd])/, what: 'discarding working-tree changes' },
  { pattern: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/, what: 'publishing a package' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, what: 'powering the machine down' },
  { pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/, what: 'making something world-writable' },
  { pattern: /\bdocker\s+(system\s+prune|volume\s+rm)\b/, what: 'destroying docker state' },
  { pattern: /\b(kubectl|helm)\s+delete\b/, what: 'deleting cluster resources' },
  { pattern: /\bhistory\s+-c\b|\bshred\b/, what: 'destroying evidence of what ran' },
  { pattern: />\s*\/dev\/sd[a-z]/, what: 'redirecting onto a disk' },
];

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
  for (const { pattern, what } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return { gate: true, reason: what };
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
