/**
 * Which pi commands a Matrix sender may run.
 *
 * `sendUserMessage()` passes `expandPromptTemplates: false`, so a `/` message
 * from Matrix has never executed anything — it reached the model as text. This
 * decides where that door is opened, and the asymmetry drives the design:
 * forgetting to allow something costs a message saying "run it in the terminal";
 * forgetting to deny something hands an allowlisted account the harness.
 */

import { describe, expect, it } from './harness.ts';
import { KNOWN_COMMANDS, MATRIX_ALLOWED, classifyMatrixCommand } from '../src/command-routing.ts';

describe('classifyMatrixCommand — what runs', () => {
  it('runs an allowed command', () => {
    expect(classifyMatrixCommand('/compact')).toEqual({
      kind: 'run',
      name: 'compact',
      text: '/compact',
    });
  });

  it('runs an allowed command with arguments', () => {
    const out = classifyMatrixCommand('/stack something');
    expect(out.kind).toBe('run');
  });

  it('allows stopping a loop but not starting one', () => {
    // The distinction the whole allowlist exists for: ending an unattended run
    // from a phone is what a channel is for; starting one is handing over the
    // machine.
    expect(classifyMatrixCommand('/loop stop').kind).toBe('run');
    expect(classifyMatrixCommand('/loop status').kind).toBe('run');
    expect(classifyMatrixCommand('/loop start rewrite everything').kind).toBe('refuse');
    expect(classifyMatrixCommand('/loop run').kind).toBe('refuse');
  });
});

describe('classifyMatrixCommand — what is refused', () => {
  it('refuses the command that edits the allowlist', () => {
    // The escalation from "can message the bot" to "can decide who may message
    // the bot", and the exact request a prompt injection makes.
    const out = classifyMatrixCommand('/prinny policy open');
    expect(out.kind).toBe('refuse');
    expect((out as { reason: string }).reason).toContain('terminal');
  });

  it('refuses everything that grants access, moves the session, or leaks it', () => {
    for (const name of [
      'trust',
      'login',
      'logout',
      'settings',
      'share',
      'export',
      'copy',
      'new',
      'fork',
      'resume',
      'session',
      'tree',
      'quit',
      'model',
      'name',
    ]) {
      expect(classifyMatrixCommand(`/${name}`).kind).toBe('refuse');
    }
  });

  it('is deny-by-default: every known command is allowed or refused, never assumed', () => {
    for (const name of KNOWN_COMMANDS) {
      const out = classifyMatrixCommand(`/${name}`);
      const expected = Object.prototype.hasOwnProperty.call(MATRIX_ALLOWED, name);
      // /loop bare has no allowed subcommand, so it refuses — that is still a decision.
      expect(out.kind === 'run' || out.kind === 'refuse').toBe(true);
      if (!expected) expect(out.kind).toBe('refuse');
    }
  });

  it('names the command and says where to run it', () => {
    const out = classifyMatrixCommand('/trust');
    expect((out as { reason: string }).reason).toContain('/trust');
  });
});

describe('classifyMatrixCommand — what is just text', () => {
  it('leaves ordinary prose alone', () => {
    expect(classifyMatrixCommand('fetch me the latest news').kind).toBe('text');
    expect(classifyMatrixCommand('').kind).toBe('text');
  });

  it('leaves a path alone, which is the obvious false positive', () => {
    expect(classifyMatrixCommand('/usr/bin/foo is broken').kind).toBe('text');
    expect(classifyMatrixCommand('/etc/hosts').kind).toBe('text');
  });

  it('leaves an unknown slash word alone rather than refusing it', () => {
    // Refusing here would be noise: it is far more likely to be prose than an
    // attempt to run something.
    expect(classifyMatrixCommand('/shrug').kind).toBe('text');
  });

  it('treats a multi-line message as prose even when line one looks like a command', () => {
    // A command is one line. Anything else is a message that opens with a slash,
    // and running it would be a surprise.
    expect(classifyMatrixCommand('/compact\nand then summarise the thread').kind).toBe('text');
  });

  it('ignores a non-string body rather than throwing mid-delivery', () => {
    expect(classifyMatrixCommand(undefined).kind).toBe('text');
    expect(classifyMatrixCommand(42).kind).toBe('text');
  });

  it('is case-insensitive on the command name', () => {
    expect(classifyMatrixCommand('/COMPACT').kind).toBe('run');
    expect(classifyMatrixCommand('/Prinny').kind).toBe('refuse');
  });
});
