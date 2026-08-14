/**
 * Reading a permission decision out of a chat message.
 *
 * Claude Code shows a request as a five-letter code and expects "y <code>" or
 * "n <code>" back. The spec is from anthropics/claude-cli-internal
 * (src/services/mcp/channelPermissions.ts): five lowercase letters a–z with
 * 'l' excluded, so it cannot be confused with 1 or I.
 *
 * Deliberately strict. A bare "yes" is conversation, not a decision, and
 * treating it as one would let an ordinary reply approve a tool call the user
 * never looked at. Case-insensitive only because phone keyboards capitalise.
 */

export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

export type PermissionDecision = { requestId: string; behavior: 'allow' | 'deny' };

/** A decision, or null when the message is ordinary conversation. */
export function parsePermissionReply(text: string): PermissionDecision | null {
  const match = PERMISSION_REPLY_RE.exec(text);
  if (!match) return null;
  return {
    requestId: match[2]!.toLowerCase(),
    behavior: match[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
  };
}

/** Callback data for the inline buttons, and the shape that parses it back. */
export const PERMISSION_CALLBACK_RE = /^perm:(allow|deny|more):([a-km-z]{5})$/;
