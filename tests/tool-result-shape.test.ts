/**
 * Every return from the `prinny` tool must carry a `content` array.
 *
 * ## The crash this prevents
 *
 * pi renders a tool result with `getTextOutput`, which does:
 *
 *     if (!result) return "";
 *     let textBlocks = result.content.filter(...)
 *
 * The guard covers a missing result. It does NOT cover a result that exists but
 * has no `content` — and a non-empty STRING is truthy, so returning one walks
 * straight past the guard into `"...".content.filter(...)`:
 *
 *     TypeError: Cannot read properties of undefined (reading 'filter')
 *       at getTextOutput
 *       at ToolExecutionComponent.createResultFallback
 *       at ToolExecutionComponent.updateDisplay
 *       at _InteractiveMode.handleEvent
 *
 * It surfaces as an `uncaughtException` and kills the session mid-turn.
 *
 * Observed 2026-08-30, pi v0.84.4: a `prinny({action:'status'})` call — setting
 * the persona's Matrix status line — hit the immersion throttle (one status
 * change per 10 minutes), that branch returned `verdict.reason` as a bare
 * string, and the session died. The stored transcript is misleading: it records
 * `content: []`, because pi's SESSION writer normalises the result while the UI
 * event does not. The saved record looks harmless; the crash is in the render.
 *
 * ## Why this is our problem and not pi's
 *
 * Reported upstream at least seven times — earendil-works/pi #5266, #5588,
 * #5599, #6678, #6788, #7695, #7764 — and closed `no-action` every time. The
 * maintainer's position, verbatim:
 *
 *   > stop ignoring the types in the type system and you will not get a crash.
 *   > this is a typescript code base, which does not do any defense checks like
 *   > you propose, because they show up as compile time errors if you use the
 *   > type system.
 *
 * That is a design decision, not an oversight, and it will not change. Honouring
 * the declared type is therefore ours to do, at every return.
 *
 * ## Why this suite reads the source
 *
 * Same reason as `tool-registration.test.ts`: `extensions/index.ts` imports
 * `@earendil-works/pi-tui`, `@earendil-works/pi-ai` and `typebox`, none of which
 * resolve under bare `node --experimental-strip-types`. Driving the real
 * `execute` needs pi's jiti and aliases. This is the cheap standing check that
 * no return regresses to a bare value.
 *
 * NOTE the deliberate exclusion: `handleCommand` is typed `Promise<string>` and
 * feeds `registerCommand`, not `registerTool`. Slash commands render through a
 * different path and a string is correct there. Only the TOOL is constrained.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from './harness.ts';

const SOURCE = readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf8');

/** The `execute` body of the registered `prinny` tool. */
function toolExecuteBody(): string {
  const at = SOURCE.indexOf("name: 'prinny',");
  expect({ marker: "name: 'prinny',", found: at >= 0 }).toEqual({
    marker: "name: 'prinny',",
    found: true,
  });
  const start = SOURCE.indexOf('async execute(', at);
  expect({ marker: 'async execute(', found: start >= 0 }).toEqual({
    marker: 'async execute(',
    found: true,
  });
  // Up to the next top-level function, which is where the handler ends.
  const end = SOURCE.indexOf('\nfunction ', start);
  return SOURCE.slice(start, end > start ? end : start + 6_000);
}

/** Returns that are known to be correctly shaped already. */
const SHAPED = [
  'return done;', // callSidecar's result: { content, details }
  'return result;', // ditto
];

describe('the prinny tool never returns a bare value to pi', () => {
  it('every return in execute() is shaped or goes through say()', () => {
    const body = toolExecuteBody();
    const returns = body.match(/return [^;]+;/g) ?? [];
    expect(returns.length > 0).toBe(true);

    const bare = returns.filter((r) => {
      if (SHAPED.includes(r.trim())) return false;
      if (r.includes('say(')) return false;
      if (/return \{\s*content/.test(r)) return false;
      return true;
    });
    // A failure here names the offending return, which is the whole point.
    expect(bare).toEqual([]);
  });

  it('say() produces the shape getTextOutput requires', () => {
    const at = SOURCE.indexOf('function say(');
    expect({ found: at >= 0 }).toEqual({ found: true });
    const body = SOURCE.slice(at, at + 400);
    expect(body).toContain('content: [{ type: \'text\' as const, text }]');
  });

  it('the four historically-bare returns are still wrapped', () => {
    const body = toolExecuteBody();
    // Each of these crashed the session before 2026-08-31.
    expect(body).toContain('return say(`Unknown action');
    expect(body).toContain("if ('refuse' in resolved) return say(resolved.refuse)");
    expect(body).toContain('return say(`prinny(${params.action}) needs a message_id');
    expect(body).toContain('if (!verdict.allowed) return say(verdict.reason)');
  });

  it('callSidecar still returns content, since two returns rely on it', () => {
    const at = SOURCE.indexOf('async function callSidecar(');
    expect({ found: at >= 0 }).toEqual({ found: true });
    const body = SOURCE.slice(at, at + 700);
    expect(body).toContain("return { content: [{ type: 'text', text }], details: { tool: name } }");
  });
});
