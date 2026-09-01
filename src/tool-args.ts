/**
 * Repairing the shape of the `prinny` tool's arguments before anything reads them.
 *
 * Pure. Imports nothing, so `tests/tool-args.test.ts` runs it under bare node.
 */

/**
 * Undo `args: { args: { … } }`.
 *
 * The tool's own parameter is called `args`, and a model that has just written
 * `{ action: "react", args: … }` writes the inner object's name a second time
 * more often than you would hope. Observed on 2026-09-01:
 *
 *     {"action":"react","args":{"args":{"emoji":"\u{1F60F}"}}}
 *
 * which spread to `{ args: { emoji } }`, left `args.emoji` undefined, and sent
 * Matrix an `m.reaction` whose `key` was undefined. `JSON.stringify` drops an
 * undefined field, so the homeserver answered **`[400] Missing aggregation
 * key`** — an error about a protocol field the model has never heard of,
 * arriving from a URL it did not construct, naming nothing it actually did
 * wrong. A model cannot act on that. It retries the same shape.
 *
 * The unwrap is SILENT because the shape is unambiguous: no action here takes a
 * parameter named `args`, so a lone `args` key holding a plain object can only
 * be this mistake. Everything else is passed through exactly as written —
 * a second key, an array, a string, a null — because a guess about a call that
 * might have been meant is worse than the call failing where the operator can
 * see it.
 */
export function unwrapDoubleArgs(raw: unknown): Record<string, unknown> {
  const outer = { ...((raw ?? {}) as Record<string, unknown>) };
  const keys = Object.keys(outer);
  if (keys.length !== 1 || keys[0] !== 'args') return outer;
  const inner = outer.args;
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return outer;
  return { ...(inner as Record<string, unknown>) };
}
