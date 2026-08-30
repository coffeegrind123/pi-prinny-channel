/**
 * The active persona, read off disk — not imported.
 *
 * `vendor/pi-persona` owns these files. Vendor packages in the origin stack must
 * not import each other, which is the same constraint that gives the compaction
 * lock three copies of its protocol and `rtk-pi` its own spelling of the
 * approved-command key. So this reads the persona's *files*, and
 * `tests/persona-profile.test.ts` asserts the two packages still agree about
 * their names and about the framing sentence the name is parsed out of.
 *
 * What it is for: openclaude mirrors the bot's Matrix display name and avatar to
 * the active persona, so the person on the other end sees who they are talking
 * to rather than a bot called `pi`. The card already carries an image URL —
 * `pi-persona` stores it in `meta.json` precisely so it does not have to be
 * re-fetched — and nothing read it until now.
 *
 * Nothing here throws. A persona that cannot be read is a bot that keeps its
 * current profile, which is the right failure: a Matrix profile is visible to
 * everyone in every room the bot is in, and a half-applied one is worse than an
 * unchanged one.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** `pi-persona`'s names, and the openclaude ones it still reads. */
const PERSONA_FILES = ['PERSONA.md', 'IDENTITY.md'];
const LIBRARY_DIRS = ['personas', 'identities'];

export interface PersonaIdentity {
  /** Display name, from the framing sentence. */
  name: string;
  /** Card image, when the library has one for this persona. */
  avatarUrl: string | null;
  /** One standalone sentence introducing the character, or null. */
  shortDescription: string | null;
  /** Two or three sentences on who they are, or null. */
  description: string | null;
}

/**
 * Budgets for the advertised profile, from `@prinny/bot`'s `Limits` (which are
 * Telegram's). Duplicated here for the same reason the compaction lock keeps
 * three copies of its protocol — packages here do not import each other — and
 * `tests/persona-profile.test.ts` asserts this copy, `Limits`, and
 * `pi-persona`'s copy all agree.
 */
export const SHORT_DESCRIPTION_MAX = 120;
export const DESCRIPTION_MAX = 512;

/**
 * The two labelled lines `pi-persona`'s extraction turn writes.
 *
 * A second copy of that package's `parsePersonaDescription`. Both are optional:
 * a persona extracted before they existed, or written by hand, advertises no
 * description, and that is not an error.
 *
 * `Description:` is a SUFFIX of `Short description:`, so the match is anchored
 * to the start of a line — a loose one reads the short line as the long one and
 * the two come out identical for every persona, which looks like it works.
 */
export function parsePersonaDescription(md: string): {
  short: string | null;
  long: string | null;
} {
  const one = (label: string, max: number): string | null => {
    const m = md.match(new RegExp(`^${label}:[ \\t]*(.+)$`, 'im'));
    const value = m?.[1]?.trim();
    if (!value) return null;
    return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
  };
  return {
    short: one('Short description', SHORT_DESCRIPTION_MAX),
    long: one('Description', DESCRIPTION_MAX),
  };
}

/**
 * The persona's name, out of the framing sentence its extraction prompt
 * mandates.
 *
 * Duplicated from `pi-persona/src/storage.ts` rather than imported, wide form
 * first so a two-word name survives — the narrow form stops at the first
 * non-word character and turns "Ada Lovelace" into "Ada".
 */
export function parsePersonaName(md: string): string | null {
  const wide = md.match(/persona of ([^.\n]{1,60})\./i);
  if (wide?.[1]) {
    const name = wide[1].trim();
    if (name) return name;
  }
  const narrow = md.match(/persona of ([A-Za-z][\w'-]{0,40})/i);
  return narrow?.[1] ?? null;
}

function activePersonaFile(agentDir: string): string | null {
  for (const name of PERSONA_FILES) {
    const path = join(agentDir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * The avatar URL the library recorded for this persona, matched on the name the
 * card was published under.
 *
 * Matched case-insensitively on `meta.json`'s `originalName`, which is the same
 * key `pi-persona` uses to decide which library entry is the active one. Newest
 * entry wins when a name was staged twice.
 */
export function findAvatarUrl(agentDir: string, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  let best: { at: string; url: string } | null = null;
  for (const dirName of LIBRARY_DIRS) {
    const dir = join(agentDir, dirName);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const metaPath = join(dir, entry, 'meta.json');
      try {
        if (!statSync(join(dir, entry)).isDirectory()) continue;
        if (!existsSync(metaPath)) continue;
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
          originalName?: unknown;
          avatarUrl?: unknown;
          processedAt?: unknown;
        };
        if (typeof meta.originalName !== 'string') continue;
        if (meta.originalName.trim().toLowerCase() !== wanted) continue;
        if (typeof meta.avatarUrl !== 'string' || !meta.avatarUrl) continue;
        const at = typeof meta.processedAt === 'string' ? meta.processedAt : '';
        if (!best || at > best.at) best = { at, url: meta.avatarUrl };
      } catch {
        // A malformed entry is skipped, not fatal. One bad meta.json must not
        // cost the bot its profile.
      }
    }
  }
  return best?.url ?? null;
}

/** The active persona, or null when there is none. */
export function readActivePersona(agentDir: string): PersonaIdentity | null {
  const file = activePersonaFile(agentDir);
  if (!file) return null;
  let md: string;
  try {
    md = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const name = parsePersonaName(md);
  if (!name) return null;
  const described = parsePersonaDescription(md);
  return {
    name,
    avatarUrl: findAvatarUrl(agentDir, name),
    shortDescription: described.short,
    description: described.long,
  };
}

/**
 * What the bot's profile should be, given a persona and the profile it had
 * before any persona was applied.
 *
 * Returns null when nothing needs doing — the common case, checked on every
 * settled run, so it must be cheap and must not churn the homeserver.
 */
export interface ProfileTarget {
  displayName: string | null;
  avatarUrl: string | null;
}

export function profileTarget(
  persona: PersonaIdentity | null,
  defaultDisplayName: string | null,
): ProfileTarget {
  if (!persona) return { displayName: defaultDisplayName, avatarUrl: null };
  return { displayName: persona.name, avatarUrl: persona.avatarUrl };
}

/** Whether a target differs from what was last applied. */
export function profileChanged(target: ProfileTarget, applied: ProfileTarget | null): boolean {
  if (!applied) return target.displayName !== null || target.avatarUrl !== null;
  return target.displayName !== applied.displayName || target.avatarUrl !== applied.avatarUrl;
}
