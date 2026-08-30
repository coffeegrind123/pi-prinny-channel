/**
 * The bot wearing the active persona's name and face.
 *
 * The files belong to `vendor/pi-persona`, which this package must not import —
 * the same constraint that gives the compaction lock three copies of its
 * protocol. So the reading is done by path, and the agreement between the two
 * packages is asserted here rather than enforced by a type.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, siblingPath, skipWithoutSibling } from './harness.ts';
import {
  DESCRIPTION_MAX,
  findAvatarUrl,
  parsePersonaDescription,
  parsePersonaName,
  SHORT_DESCRIPTION_MAX,
  profileChanged,
  profileTarget,
  readActivePersona,
} from '../src/persona-profile.ts';

const FRAMING = (name: string) =>
  `You are an AI coding assistant that also speaks and behaves with the persona of ${name}. Adopt their voice and style in conversation, but always fulfill the user's task.`;

function agentDir(): string {
  return mkdtempSync(join(tmpdir(), 'prinny-persona-'));
}

function library(root: string, dir: string, slug: string, meta: Record<string, unknown>): void {
  const entry = join(root, dir, slug);
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, 'meta.json'), JSON.stringify(meta), 'utf8');
}

describe('reading the active persona', () => {
  it('finds the name and the card image', () => {
    const root = agentDir();
    writeFileSync(join(root, 'PERSONA.md'), FRAMING('Crystal'), 'utf8');
    library(root, 'personas', 'crystal-abc123', {
      originalName: 'Crystal',
      avatarUrl: 'https://avatars.example/crystal.png',
      processedAt: '2026-08-30T10:00:00.000Z',
    });
    expect(readActivePersona(root)).toEqual({
      name: 'Crystal',
      avatarUrl: 'https://avatars.example/crystal.png',
      shortDescription: null,
      description: null,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the advertised description written by the extraction turn', () => {
    const root = agentDir();
    writeFileSync(
      join(root, 'PERSONA.md'),
      `${FRAMING('Crystal')}\n\nShort description: A shy fox-girl who calls you master.\nDescription: Crystal stammers when flustered and brightens when given a task.`,
      'utf8'
    );
    const persona = readActivePersona(root)!;
    expect(persona.shortDescription).toBe('A shy fox-girl who calls you master.');
    expect(persona.description).toBe(
      'Crystal stammers when flustered and brightens when given a task.'
    );
    rmSync(root, { recursive: true, force: true });
  });

  // A persona from before the description existed advertises none. The name
  // still goes out — the absence must not cost the whole profile.
  it('a persona without a description still yields a name', () => {
    const root = agentDir();
    writeFileSync(join(root, 'PERSONA.md'), FRAMING('Crystal'), 'utf8');
    const persona = readActivePersona(root)!;
    expect(persona.name).toBe('Crystal');
    expect(persona.shortDescription).toBe(null);
    expect(persona.description).toBe(null);
    rmSync(root, { recursive: true, force: true });
  });

  // "Description:" is a suffix of "Short description:". A loose match reads the
  // short line as the long one and the two come out identical for every
  // persona — which looks like it works.
  it('does not read the short line as the long one', () => {
    const d = parsePersonaDescription('Short description: the short one.\nDescription: the long one.');
    expect(d.short).toBe('the short one.');
    expect(d.long).toBe('the long one.');
  });

  it('is null when no persona is active', () => {
    const root = agentDir();
    expect(readActivePersona(root)).toBe(null);
    rmSync(root, { recursive: true, force: true });
  });

  // A persona with no card image is ordinary — a hand-written PERSONA.md has no
  // library entry at all. The name still applies; only the avatar is skipped.
  it('gives a name with no avatar when the library has no image', () => {
    const root = agentDir();
    writeFileSync(join(root, 'PERSONA.md'), FRAMING('Ada Lovelace'), 'utf8');
    expect(readActivePersona(root)).toEqual({
      name: 'Ada Lovelace',
      avatarUrl: null,
      shortDescription: null,
      description: null,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("reads openclaude's names too", () => {
    const root = agentDir();
    writeFileSync(join(root, 'IDENTITY.md'), FRAMING('Nadia'), 'utf8');
    library(root, 'identities', 'nadia-1', {
      originalName: 'Nadia',
      avatarUrl: 'https://avatars.example/nadia.png',
    });
    expect(readActivePersona(root)?.avatarUrl).toBe('https://avatars.example/nadia.png');
    rmSync(root, { recursive: true, force: true });
  });

  it('prefers the newest entry when a card was staged twice', () => {
    const root = agentDir();
    library(root, 'personas', 'old', {
      originalName: 'Crystal',
      avatarUrl: 'https://avatars.example/old.png',
      processedAt: '2026-08-01T00:00:00.000Z',
    });
    library(root, 'personas', 'new', {
      originalName: 'Crystal',
      avatarUrl: 'https://avatars.example/new.png',
      processedAt: '2026-08-30T00:00:00.000Z',
    });
    expect(findAvatarUrl(root, 'Crystal')).toBe('https://avatars.example/new.png');
    rmSync(root, { recursive: true, force: true });
  });

  // One bad meta.json must not cost the bot its profile.
  it('skips a malformed library entry instead of throwing', () => {
    const root = agentDir();
    const entry = join(root, 'personas', 'broken');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'meta.json'), '{ not json', 'utf8');
    library(root, 'personas', 'good', {
      originalName: 'Crystal',
      avatarUrl: 'https://avatars.example/good.png',
    });
    expect(findAvatarUrl(root, 'Crystal')).toBe('https://avatars.example/good.png');
    rmSync(root, { recursive: true, force: true });
  });

  it('matches the name case-insensitively, as pi-persona does', () => {
    const root = agentDir();
    library(root, 'personas', 'x', { originalName: 'CRYSTAL', avatarUrl: 'https://a/x.png' });
    expect(findAvatarUrl(root, 'crystal')).toBe('https://a/x.png');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('what the profile should become', () => {
  it('wears the persona when there is one', () => {
    const persona = { name: 'Crystal', avatarUrl: 'https://a/c.png' };
    expect(profileTarget(persona, 'pi')).toEqual({
      displayName: 'Crystal',
      avatarUrl: 'https://a/c.png',
    });
  });

  // Clearing a persona must put the bot's own name back, not leave the last
  // character's name on a bot that is no longer them.
  it('restores the default name when the persona is cleared', () => {
    expect(profileTarget(null, 'pi')).toEqual({ displayName: 'pi', avatarUrl: null });
  });

  it('changes nothing it does not know how to restore', () => {
    expect(profileTarget(null, null)).toEqual({ displayName: null, avatarUrl: null });
  });
});

describe('when the homeserver is actually touched', () => {
  // Checked on every settled run, so the common case has to be free.
  it('does nothing when the target is unchanged', () => {
    const applied = { displayName: 'Crystal', avatarUrl: 'https://a/c.png' };
    expect(profileChanged({ ...applied }, applied)).toBe(false);
  });

  it('notices a new persona, a new avatar, and a clear', () => {
    const applied = { displayName: 'Crystal', avatarUrl: 'https://a/c.png' };
    expect(profileChanged({ displayName: 'Nadia', avatarUrl: 'https://a/c.png' }, applied)).toBe(true);
    expect(profileChanged({ displayName: 'Crystal', avatarUrl: 'https://a/n.png' }, applied)).toBe(true);
    expect(profileChanged({ displayName: 'pi', avatarUrl: null }, applied)).toBe(true);
  });

  it('does nothing on a first run with nothing to apply', () => {
    expect(profileChanged({ displayName: null, avatarUrl: null }, null)).toBe(false);
  });
});

// The two packages have to agree about the file names and about the sentence the
// name is parsed out of. Skipped standalone; instantcoffee's CI asserts it ran.
describe('the two packages agree about the persona files', {
  skip: skipWithoutSibling('pi-persona', 'src/storage.ts'),
}, () => {
  it('on the file and directory names', async () => {
    const storage = await import(siblingPath('pi-persona', 'src/storage.ts') as string);
    expect(storage.PERSONA_FILE).toBe('PERSONA.md');
    expect(storage.LEGACY_PERSONA_FILE).toBe('IDENTITY.md');
    expect(storage.LIBRARY_DIR).toBe('personas');
    expect(storage.LEGACY_LIBRARY_DIR).toBe('identities');
  });

  it('on the name parsed out of the framing sentence', async () => {
    const storage = await import(siblingPath('pi-persona', 'src/storage.ts') as string);
    for (const name of ['Crystal', 'Ada Lovelace', "O'Brien"]) {
      expect(parsePersonaName(FRAMING(name))).toBe(storage.parsePersonaName(FRAMING(name)));
      expect(parsePersonaName(FRAMING(name))).toBe(name);
    }
    expect(parsePersonaName('nothing here')).toBe(storage.parsePersonaName('nothing here'));
  });

  // The avatar URL only exists because pi-persona stores it. If it stopped, this
  // feature would silently do half its job.
  it('on the description parser and its budgets', async () => {
    const storage = await import(siblingPath('pi-persona', 'src/storage.ts') as string);
    // The budgets are @prinny/bot's Limits, duplicated in both packages because
    // neither may import the other. Three copies, asserted equal here.
    expect(SHORT_DESCRIPTION_MAX).toBe(storage.SHORT_DESCRIPTION_MAX);
    expect(DESCRIPTION_MAX).toBe(storage.DESCRIPTION_MAX);
    const md = 'Short description: short.\nDescription: long.';
    expect(parsePersonaDescription(md)).toEqual(storage.parsePersonaDescription(md));
    const over = `Description: ${'x'.repeat(900)}`;
    expect(parsePersonaDescription(over).long).toBe(storage.parsePersonaDescription(over).long);
  });

  it('that the extraction prompt still asks for a description at all', async () => {
    // If it stopped, every persona would advertise a name and nothing else, and
    // nothing here would fail — the parser would just always return null.
    const { EXTRACTION_PROMPT } = await import(
      siblingPath('pi-persona', 'src/processor.ts') as string
    );
    expect(EXTRACTION_PROMPT.includes('Short description:')).toBe(true);
    expect(EXTRACTION_PROMPT.includes(`<= ${SHORT_DESCRIPTION_MAX} characters`)).toBe(true);
  });

  it('that meta.json still carries avatarUrl', async () => {
    const storage = await import(siblingPath('pi-persona', 'src/storage.ts') as string);
    const root = agentDir();
    const staged = storage.stageCardForProcessing(
      root,
      {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          name: 'Crystal', description: '', personality: '', first_mes: '', mes_example: '',
          scenario: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
          alternate_greetings: [], tags: [], creator: '', character_version: '1',
        },
      },
      { avatarUrl: 'https://avatars.example/from-the-card.png' }
    );
    expect(staged.slug.startsWith('crystal-')).toBe(true);
    expect(findAvatarUrl(root, 'Crystal')).toBe('https://avatars.example/from-the-card.png');
    rmSync(root, { recursive: true, force: true });
  });
});
