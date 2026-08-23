/**
 * AN1, this side — the settings file that reset the permission gate.
 *
 * `readSettings`' own docstring makes a promise its catch cannot keep:
 *
 * > Anything malformed falls back to the default for that key alone; a typo in
 * > one setting must not silently reset the rest, **because the rest includes
 * > the permission mode**.
 *
 * True of a bad VALUE — `asEnum` and `asPositiveInt` are per key. False of a bad
 * FILE, which is the likelier typo in hand-edited JSON: `JSON.parse` throws,
 * `raw` stays `{}`, and every key falls to its default. `permissionMode` goes
 * from `all` to `off` — the Matrix approval relay switched off by a missing
 * comma, silently — and the next `/prinny set` writes those defaults over the
 * file, so the settings are not merely unread, they are gone.
 *
 * Three things are pinned here:
 *
 *   1. the read tells absent from malformed, and says which;
 *   2. the write moves an unreadable file aside before replacing it;
 *   3. this copy of the rule and `vendor/pi-subagents-lite`'s agree — the same
 *      cross-package check `compaction-lock.test.ts` makes for the four copies
 *      of the compaction protocol, and for the same reason: a protocol with two
 *      implementations is worth exactly as much as the assertion that they agree.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { quarantine, quarantineName, readJsonObject, writeJsonAtomic } from '../src/json-store.ts';
import * as subagents from '../../pi-subagents-lite/src/config/json-store.ts';
import { DEFAULT_SETTINGS, readSettings, readSettingsLayer, writeSettings } from '../src/config.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'an1-prinny-'));
}

/** A settings file an operator would recognise, with one comma missing. */
const CONFIGURED = {
  deliverAs: 'steer',
  forward: 'all',
  permissionMode: 'all',
  permissionTools: ['bash', 'write'],
  permissionTimeoutSeconds: 600,
  requestTimeoutSeconds: 90,
  connectTimeoutSeconds: 180,
};

function brokenSettingsFile(dir: string): string {
  const file = join(dir, 'pi.json');
  writeFileSync(file, JSON.stringify(CONFIGURED, null, 2).replace('"forward": "all",', '"forward": "all"'));
  return file;
}

describe('readSettingsLayer', () => {
  it('reads a good file', () => {
    const dir = scratch();
    const file = join(dir, 'pi.json');
    writeFileSync(file, JSON.stringify(CONFIGURED));
    const layer = readSettingsLayer(file);
    assert.equal(layer.status, 'loaded');
    assert.equal(layer.settings.permissionMode, 'all');
    assert.equal(layer.settings.permissionTimeoutSeconds, 600);
  });

  it('an absent file is defaults, and says absent', () => {
    const layer = readSettingsLayer(join(scratch(), 'pi.json'));
    assert.equal(layer.status, 'absent');
    assert.deepEqual(layer.settings, DEFAULT_SETTINGS);
  });

  it('a broken file is defaults, and says MALFORMED', () => {
    const layer = readSettingsLayer(brokenSettingsFile(scratch()));
    assert.equal(layer.status, 'malformed');
    assert.ok(layer.error, 'the operator gets the parser own words');
    assert.equal(
      layer.settings.permissionMode,
      'off',
      'this is the damage: the approval relay is off and nothing said so',
    );
  });

  it('a bad VALUE still falls back alone — the control the docstring promises', () => {
    const dir = scratch();
    const file = join(dir, 'pi.json');
    writeFileSync(file, JSON.stringify({ ...CONFIGURED, requestTimeoutSeconds: 'soon' }));
    const layer = readSettingsLayer(file);
    assert.equal(layer.status, 'loaded');
    assert.equal(layer.settings.permissionMode, 'all', 'the rest of the file survives a bad value');
    assert.equal(layer.settings.requestTimeoutSeconds, DEFAULT_SETTINGS.requestTimeoutSeconds);
  });

  it('readSettings is still the same answer, without the status', () => {
    const file = brokenSettingsFile(scratch());
    assert.deepEqual(readSettings(file), readSettingsLayer(file).settings);
  });
});

describe('AN1 — writeSettings never silently replaces an unreadable file', () => {
  it('quarantines the bytes and writes the new settings', () => {
    const dir = scratch();
    const file = brokenSettingsFile(dir);
    const before = readFileSync(file, 'utf8');

    writeSettings({ ...DEFAULT_SETTINGS, forward: 'off' }, file);

    const survivor = readdirSync(dir).find((name) => name.includes('.corrupt-'));
    assert.ok(survivor, 'the operator bytes have to still exist somewhere');
    assert.equal(readFileSync(join(dir, survivor), 'utf8'), before, '…unchanged');
    assert.equal(readSettingsLayer(file).settings.forward, 'off', 'and the save still happened');
  });

  it('a good file is replaced in place, with no quarantine — the control', () => {
    const dir = scratch();
    const file = join(dir, 'pi.json');
    writeFileSync(file, JSON.stringify(CONFIGURED));
    writeSettings({ ...DEFAULT_SETTINGS, forward: 'off' }, file);
    const siblings = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert.deepEqual(siblings, [], 'nothing to keep: the file parsed');
  });

  it('an absent file is created, with no quarantine', () => {
    const dir = scratch();
    const file = join(dir, 'pi.json');
    writeSettings(DEFAULT_SETTINGS, file);
    assert.equal(existsSync(file), true);
    assert.deepEqual(readSettings(file), DEFAULT_SETTINGS);
  });
});

describe('the two copies of the rule agree', () => {
  const cases: Array<[string, string]> = [
    ['absent', ''],
    ['malformed', '{ "a": 1 '],
    ['malformed', '[1,2]'],
    ['loaded', '{ "a": 1 }'],
    ['absent', '   \n '],
  ];

  it('readJsonObject gives the same verdict on both sides', () => {
    const dir = scratch();
    for (const [expected, body] of cases) {
      const file = join(dir, `case-${cases.indexOf([expected, body])}-${body.length}.json`);
      if (body !== '') writeFileSync(file, body);
      const here = readJsonObject(file);
      const there = subagents.readJsonObject(file);
      assert.equal(here.status, expected, `prinny: ${JSON.stringify(body)}`);
      assert.equal(there.status, expected, `subagents: ${JSON.stringify(body)}`);
      assert.deepEqual(here.value, there.value);
    }
  });

  it('quarantineName is the same name on both sides', () => {
    const at = Date.parse('2026-08-23T06:40:50.341Z');
    assert.equal(quarantineName('/tmp/pi.json', at), subagents.quarantineName('/tmp/pi.json', at));
  });

  it('quarantine moves the file on both sides', () => {
    const dir = scratch();
    for (const [i, mover] of [quarantine, subagents.quarantine].entries()) {
      const file = join(dir, `move-${i}.json`);
      writeFileSync(file, 'broken');
      const moved = mover(file);
      assert.ok(moved, 'both have to move it');
      assert.equal(existsSync(file), false);
    }
  });

  it('writeJsonAtomic leaves the same bytes on both sides', () => {
    const dir = scratch();
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    writeJsonAtomic(a, { x: 1 });
    subagents.writeJsonAtomic(b, { x: 1 });
    assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
  });
});
