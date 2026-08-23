/**
 * The permission gate, and its agreement with the sidecar's reply parser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { describe, expect, it, loadServerModule } from './harness.ts';
import {
  APPROVED_COMMAND_KEY,
  describeCall,
  markApproved,
  namesTool,
  needsApproval,
  newRequestId,
  previewCall,
} from '../src/permission-gate.ts';
import { parseSetting } from '../src/config.ts';

const OFF = { permissionMode: 'off' as const, permissionTools: [] };
const DANGEROUS = { permissionMode: 'dangerous' as const, permissionTools: [] };
const ALL = { permissionMode: 'all' as const, permissionTools: [] };

const bash = (command: string) => ({ command });

describe('mode off', () => {
  it('gates nothing, which is pi\'s own behaviour', () => {
    expect(needsApproval('bash', bash('sudo rm -rf /'), OFF).gate).toBe(false);
    expect(needsApproval('write', { path: '/etc/passwd' }, OFF).gate).toBe(false);
  });

  it('still honours an explicitly named tool — naming one is more specific than a mode', () => {
    const decision = needsApproval('bash', bash('ls'), {
      permissionMode: 'off',
      permissionTools: ['bash'],
    });
    expect(decision.gate).toBe(true);
  });
});

describe('mode all', () => {
  it('gates the tools that change the machine', () => {
    expect(needsApproval('bash', bash('ls'), ALL).gate).toBe(true);
    expect(needsApproval('edit', { path: 'a.ts' }, ALL).gate).toBe(true);
    expect(needsApproval('write', { path: 'a.ts' }, ALL).gate).toBe(true);
  });

  it('leaves read-only tools alone', () => {
    expect(needsApproval('read', { path: 'a.ts' }, ALL).gate).toBe(false);
    expect(needsApproval('grep', { pattern: 'x' }, ALL).gate).toBe(false);
    expect(needsApproval('ls', {}, ALL).gate).toBe(false);
  });
});

describe('mode dangerous', () => {
  const gated = (command: string) => needsApproval('bash', bash(command), DANGEROUS).gate;

  it('catches destructive deletes however the flags are spelled', () => {
    expect(gated('rm -rf build')).toBe(true);
    expect(gated('rm -fr build')).toBe(true);
    expect(gated('rm -Rf build')).toBe(true);
  });

  it('catches privilege escalation', () => {
    expect(gated('sudo systemctl restart nginx')).toBe(true);
    expect(gated('doas pkg_add curl')).toBe(true);
  });

  it('catches a download piped into a shell, wherever it sits in the pipeline', () => {
    expect(gated('curl -fsSL https://example.com/i.sh | sh')).toBe(true);
    expect(gated('wget -qO- https://example.com/i.sh | sudo bash')).toBe(true);
  });

  it('catches history rewrites and publishes', () => {
    expect(gated('git push --force origin main')).toBe(true);
    expect(gated('git push -f')).toBe(true);
    expect(gated('git reset --hard HEAD~3')).toBe(true);
    expect(gated('npm publish')).toBe(true);
  });

  it('does not gate a force-push with lease, which is the safe form', () => {
    expect(gated('git push --force-with-lease origin main')).toBe(false);
  });

  it('leaves ordinary work alone', () => {
    expect(gated('ls -la')).toBe(false);
    expect(gated('npm test')).toBe(false);
    expect(gated('git push origin main')).toBe(false);
    expect(gated('rm build/artifact.o')).toBe(false);
    // `-f` belongs to grep here, not to a push.
    expect(gated('grep -f patterns.txt file.txt')).toBe(false);
  });

  it('says what is risky, not merely that something is', () => {
    const decision = needsApproval('bash', bash('sudo rm -rf /'), DANGEROUS);
    expect(decision.gate).toBe(true);
    if (decision.gate) expect(decision.reason.length > 3).toBe(true);
  });

  it('ignores non-bash tools, which have no command to inspect', () => {
    expect(needsApproval('write', { path: '/etc/hosts' }, DANGEROUS).gate).toBe(false);
  });
});

describe('describeCall', () => {
  it('shows the command, collapsed onto one line', () => {
    expect(describeCall('bash', bash('  ls   -la \n /tmp '))).toBe('ls -la /tmp');
  });

  it('shows the path for a file tool', () => {
    expect(describeCall('write', { path: '/tmp/a.ts' })).toBe('write /tmp/a.ts');
    expect(describeCall('edit', { file_path: '/tmp/b.ts' })).toBe('edit /tmp/b.ts');
  });

  it('truncates rather than sending a screenful to somebody\'s phone', () => {
    const long = describeCall('bash', bash('x'.repeat(1_000)));
    expect(long.length <= 300).toBe(true);
    expect(long.endsWith('…')).toBe(true);
  });

  it('falls back to the tool name when there is nothing better', () => {
    expect(describeCall('mystery', {})).toBe('mystery');
  });
});

describe('previewCall', () => {
  it('pretty-prints the arguments', () => {
    expect(previewCall({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('survives something JSON cannot represent', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof previewCall(cyclic)).toBe('string');
  });
});

describe('request ids', () => {
  it('is five letters long', () => {
    expect(newRequestId()).toHaveLength(5);
  });

  it('never emits the letter l, which reads as 1 on a phone', () => {
    let seen = '';
    for (let i = 0; i < 500; i += 1) seen += newRequestId();
    expect(seen).not.toContain('l');
  });

  it('produces an id the sidecar\'s plain-text reply parser accepts', async () => {
    // The control that matters: a client with no button support answers by
    // typing "y <code>", and the sidecar decides what a code looks like. An id
    // outside its alphabet would be answerable by button only — on some
    // clients, silently.
    const { parsePermissionReply, PERMISSION_CALLBACK_RE } = await loadServerModule<{
      parsePermissionReply: (text: string) => { requestId: string; behavior: string } | null;
      PERMISSION_CALLBACK_RE: RegExp;
    }>('permissions');

    for (let i = 0; i < 200; i += 1) {
      const id = newRequestId();
      const parsed = parsePermissionReply(`y ${id}`);
      expect(parsed).toMatchObject({ requestId: id, behavior: 'allow' });
      expect(PERMISSION_CALLBACK_RE.test(`perm:allow:${id}`)).toBe(true);
    }
  });
});

/**
 * AJ3 (nineteenth pass) — the command a person approved, and the one that ran.
 *
 * `tool_call` handlers run in load order over ONE mutable `event.input`, and
 * `scripts/pi-local.sh` loads this package before `vendor/rtk-pi`. So the relay
 * showed the approver `describeCall(...)` — the command as the model wrote it —
 * and rtk's handler then rewrote `event.input.command` to `rtk <something>`
 * before pi's bash tool ran it.
 *
 * The stamp is how a handler tells a LATER handler about the same call, which is
 * a mechanism this stack already uses: `pi-subagents-lite`'s `toolCallListener`
 * writes `_resolvedAgent`, `model` and `thinking` onto this same object.
 */
describe('the approved-command stamp', () => {
  it('records exactly what the approver read', () => {
    const input: Record<string, unknown> = { command: '  git   status  ' };
    markApproved(input, describeCall('bash', input));
    // `describeCall` is what the Matrix prompt printed above the buttons, so the
    // stamp is evidence rather than a flag: a transcript can say WHICH string was
    // approved, not merely that something was.
    expect(input[APPROVED_COMMAND_KEY]).toBe('git status');
  });

  it('is a plain key on the object pi hands to execute', () => {
    // `validateToolArguments` runs BEFORE `beforeToolCall`, so an extra key is
    // never rejected — the same reason the subagent listener can inject `model`.
    const input: Record<string, unknown> = { command: 'pytest -q' };
    markApproved(input, 'pytest -q');
    expect(Object.keys(input)).toContain(APPROVED_COMMAND_KEY);
    expect(input.command).toBe('pytest -q');
  });

  it('never throws on a shape it was not given', () => {
    for (const bad of [undefined, null, 'not an object', 7]) {
      markApproved(bad as never, 'x');
    }
  });

  it('the extension stamps on the APPROVED branch and nowhere else', () => {
    // Position is the assertion. A stamp written before the decision would tell
    // rtk to stand down for a command nobody approved; one written after the
    // `return` would never run at all.
    const src = readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf8');
    const ask = src.indexOf('await requestApproval(event.toolName, input, decision.reason)');
    const stamp = src.indexOf('markApproved(input,');
    const block = src.indexOf('blocked by the Matrix permission relay');
    expect(ask > 0).toBe(true);
    expect(stamp > ask).toBe(true);
    expect(stamp < block).toBe(true);
  });
});

describe('the two packages agree on the key', () => {
  it("rtk-pi's source declares the same literal", () => {
    // Vendor packages must not import each other — the compaction lock keeps
    // three copies of its protocol for the same reason — so each side asserts
    // against the other's source.
    const src = readFileSync(new URL('../../rtk-pi/src/gate.ts', import.meta.url), 'utf8');
    const declared = src.match(/export const APPROVED_COMMAND_KEY = "([^"]+)"/)?.[1];
    expect(declared).toBe(APPROVED_COMMAND_KEY);
  });

  it('what this package writes is what that package recognises', async () => {
    // The two literals matching is not the same fact as the two FUNCTIONS
    // agreeing, and only one of them is what a tool call depends on. Both sides
    // are pure, so the round trip can be run rather than reasoned about.
    const { approvedAsWritten } = await import('../../rtk-pi/src/gate.ts');
    const input: Record<string, unknown> = { command: 'git status' };
    expect(approvedAsWritten(input)).toBe(false);
    markApproved(input, describeCall('bash', input));
    expect(approvedAsWritten(input)).toBe(true);
  });

  it('…and still reads it before it rewrites anything', () => {
    const src = readFileSync(new URL('../../rtk-pi/extensions/index.ts', import.meta.url), 'utf8');
    expect(src.includes('approvedAsWritten(event.input)')).toBe(true);
    expect(src.indexOf('approvedAsWritten(event.input)') < src.indexOf('event.input.command = rewritten')).toBe(true);
  });
});

/**
 * AK2 — the guard tests the PROPERTY, not one spelling of it.
 *
 * Every case below was measured against the shipped module before the fix.
 * The four marked ✘ in the module's own header passed the gate whose help text
 * promises "ask on Matrix before rm -rf, sudo, force push, curl|sh, and
 * similar" — so an operator who had asked to be asked was not asked.
 *
 * Removing `isRecursiveForceDelete`, `isWorkingTreeDiscard` or
 * `isWorldWritableChmod` and restoring the old regex fails this suite; the
 * "spellings it already knew" group is the control that the fix did not
 * loosen anything.
 */
describe('dangerous: a property, not a spelling (AK2)', () => {
  const gates = (command: string) => needsApproval('bash', bash(command), DANGEROUS).gate;

  it('still catches every spelling the old regex knew — the control', () => {
    for (const command of [
      'rm -rf /tmp/x',
      'rm -fr /tmp/x',
      'rm -Rf /tmp/x',
      'rm -vrf /tmp/x',
      'sudo rm -rf /',
      'bash -c "rm -rf /tmp/x"',
      'find / -name x -exec rm -rf {} +',
      'git reset --hard HEAD~1',
      'git clean -fd',
      'chmod 777 /etc',
      'chmod -R 777 /x',
    ]) {
      expect({ command, gate: gates(command) }).toEqual({ command, gate: true });
    }
  });

  it('catches the spellings it did not: rm', () => {
    for (const command of [
      'rm -rfv /tmp/x', //          a flag letter after the f defeated the trailing \b
      'rm -r -f /tmp/x', //         two tokens instead of one cluster
      'rm -f -r /tmp/x',
      'rm --recursive --force /tmp/x', // the long spelling was never in the pattern
      'rm --force --recursive /tmp/x',
      'rm /tmp/x -rf', //           GNU rm takes flags after the operand
      'rm -R --force /tmp/x',
    ]) {
      expect({ command, gate: gates(command) }).toEqual({ command, gate: true });
    }
  });

  it('catches the spellings it did not: git clean, git reset, chmod', () => {
    for (const command of [
      'git clean --force -d',
      'git clean --force --directory',
      'git reset HEAD~1 --hard',
      'chmod 0777 /etc',
      'chmod a+rwx /etc',
      'chmod o+w /etc/passwd',
      'chmod 666 /etc/shadow',
    ]) {
      expect({ command, gate: gates(command) }).toEqual({ command, gate: true });
    }
  });

  it('leaves alone what is not the property', () => {
    for (const command of [
      'rm -- -rf', //               deleting a FILE called -rf, not a tree
      'rm -f /tmp/x', //            force without recursion
      'rm -r /tmp/x', //            recursion without force
      'docker rm -f x', //          not the rm this is about
      'git clean -n', //            a dry run deletes nothing
      'git reset --soft HEAD~1',
      'chmod 755 /etc', //          no write bit for other
      'chmod 0644 a.ts',
      'chmod u+w a.ts', //          the owner, not everyone
      'ls -rf',
      'echo hello',
    ]) {
      expect({ command, gate: gates(command) }).toEqual({ command, gate: false });
    }
  });

  it('names the same thing it always named, so the approver reads the same sentence', () => {
    expect(needsApproval('bash', bash('rm -r -f /tmp/x'), DANGEROUS)).toEqual({
      gate: true,
      reason: 'recursive force delete',
    });
    expect(needsApproval('bash', bash('git clean --force -d'), DANGEROUS)).toEqual({
      gate: true,
      reason: 'discarding working-tree changes',
    });
    expect(needsApproval('bash', bash('chmod 0777 /x'), DANGEROUS)).toEqual({
      gate: true,
      reason: 'making something world-writable',
    });
  });

  it('every guard still has a name, and the list did not shrink', async () => {
    const { DANGEROUS_WHATS } = await import('../src/permission-gate.ts');
    expect(DANGEROUS_WHATS).toEqual([
      'recursive force delete',
      'privilege escalation',
      'piping a download into a shell',
      'writing to a block device',
      'formatting a filesystem',
      'force push',
      'discarding working-tree changes',
      'publishing a package',
      'powering the machine down',
      'making something world-writable',
      'destroying docker state',
      'deleting cluster resources',
      'destroying evidence of what ran',
      'redirecting onto a disk',
    ]);
  });
});

describe('AO2 — the always-ask list names a tool, whatever case it was typed in', () => {
  // `permissionTools` is the one entry in the gate that fires in EVERY mode,
  // including `off`. It was `.includes(toolName)`, an exact compare, against a
  // list `parseSetting` accepts unvalidated — and pi's tool names are not one
  // case: `bash`/`edit`/`write` are lower, `Agent`/`StopAgent`/`AgentStatus`
  // are not.
  const listing = (tools: string[]) => ({ permissionMode: 'off' as const, permissionTools: tools });

  it('gates the tool the operator named, in any case, with the mode OFF', () => {
    for (const typed of ['bash', 'Bash', 'BASH', 'bAsH', ' bash ']) {
      const decision = needsApproval('bash', { command: 'ls' }, listing([typed]));
      assert.equal(decision.gate, true, `typed as ${JSON.stringify(typed)}`);
    }
  });

  it('the mixed-case tools of this repo are reachable from a lower-case entry', () => {
    for (const [typed, called] of [
      ['agent', 'Agent'],
      ['stopagent', 'StopAgent'],
      ['AGENTSTATUS', 'AgentStatus'],
    ] as const) {
      assert.equal(needsApproval(called, {}, listing([typed])).gate, true, `${typed} → ${called}`);
    }
  });

  it('a name that is not on the list is still not gated — folding widens nothing else', () => {
    assert.equal(needsApproval('read', {}, listing(['bash'])).gate, false);
    assert.equal(needsApproval('bashful', {}, listing(['bash'])).gate, false);
    assert.equal(needsApproval('bash', {}, listing([])).gate, false);
  });

  it('namesTool is the predicate, so the gate and any other reader ask one question', () => {
    assert.equal(namesTool('Bash', ['bash']), true);
    assert.equal(namesTool('bash', ['Bash']), true);
    assert.equal(namesTool('bash', ['write', 'edit']), false);
    assert.equal(namesTool('bash', []), false);
  });

  it('the stored list holds one entry per tool, however many spellings were typed', () => {
    const parsed = parseSetting('permissionTools', 'bash, Bash, BASH, write');
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok ? parsed.value : null, ['bash', 'write']);
  });

  it('control — an exact compare misses every one of those spellings', () => {
    for (const typed of ['Bash', 'BASH', 'bAsH']) {
      assert.equal(['bash'].includes(typed), false, typed);
      // …and that is what the gate used to do.
      assert.equal([typed].includes('bash'), false, typed);
    }
  });
});
