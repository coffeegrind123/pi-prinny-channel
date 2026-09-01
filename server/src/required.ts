/**
 * Checking a tool call against the schema the tool itself advertised.
 *
 * Pure. Imports nothing, so `tests/required.test.ts` runs it under bare node —
 * `server.ts` cannot be imported by a test, because loading it stands the MCP
 * server up on stdio.
 *
 * WHY THIS EXISTS. The MCP SDK publishes `inputSchema` and validates NOTHING
 * against it: the handler is handed `req.params.arguments` exactly as they
 * arrived. So a parameter the model omitted — or nested one level too deep —
 * reached the operation as `undefined`, and whatever was downstream got to
 * answer for it.
 *
 * That answer was consistently useless. `react` with no `emoji` sent Matrix an
 * `m.reaction` whose `key` was undefined, and Synapse replied **`[400] Missing
 * aggregation key`**. Nothing in that sentence names the tool, the call, or the
 * parameter that was actually omitted; the failure was reported as a property
 * of the homeserver. A boundary should answer for its own contract.
 *
 * EMPTINESS IS NOT A GLOBAL RULE, and the first version of this file got that
 * wrong. `""` satisfies JSON Schema's `required` and satisfies nothing
 * downstream for a reaction key — but `set_biography` documents `text` as
 * "Empty clears it", and `set_topic` and `set_bot_profile` read the same way.
 * A blanket "empty counts as missing" would have made clearing a biography
 * impossible, trading a rare opaque error for a common broken feature. So the
 * rule is declared per parameter, with JSON Schema's own `minLength`, in the
 * schema the tool already publishes — one place, visible to the model too.
 */

/** The half of a tool's inputSchema this module reads. */
export interface RequiredSchema {
  required?: readonly string[];
  properties?: Readonly<Record<string, { minLength?: number } | undefined>>;
}

/** Names the tool required and did not get. Empty when the call is well-formed. */
export function missingRequired(
  schema: RequiredSchema | undefined,
  args: Record<string, unknown>
): string[] {
  const required = schema?.required;
  if (!required || required.length === 0) return [];
  return required.filter((key) => {
    const value = args[key];
    if (value === undefined || value === null) return true;
    if (typeof value !== 'string') return false;
    // Only where the schema says an empty string is not an answer. See the
    // header: for several tools it is one.
    const minLength = schema?.properties?.[key]?.minLength ?? 0;
    return minLength > 0 && value.trim().length === 0;
  });
}

/**
 * The refusal, or null when there is nothing to refuse.
 *
 * It names three things deliberately: what is missing, what the tool wanted,
 * and what actually arrived. The last is what turns "you forgot emoji" into
 * "you sent `args` when you meant its contents" without the model having to
 * guess — and it is the one a schema-shaped error message always leaves out.
 */
export function requiredParamError(
  toolName: string,
  schema: RequiredSchema | undefined,
  args: Record<string, unknown>
): string | null {
  const missing = missingRequired(schema, args);
  if (missing.length === 0) return null;
  const received = Object.keys(args);
  return (
    `${toolName} is missing required ${missing.length === 1 ? 'parameter' : 'parameters'}: ` +
    `${missing.join(', ')}. It takes ${(schema?.required ?? []).join(', ')}; it received ` +
    `${received.length > 0 ? received.join(', ') : 'nothing'}.`
  );
}
