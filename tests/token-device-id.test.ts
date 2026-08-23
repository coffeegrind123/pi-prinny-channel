/**
 * AN3 — the device id a new token inherited.
 *
 * A Matrix access token belongs to a DEVICE. `PRINNY_DEVICE_ID` is written by
 * whoever minted the last one — a password login through `onCredentials`, or
 * `resolveDeviceId`'s `/account/whoami` lookup — and `/prinny configure token`
 * wrote the new token beside it without touching it.
 *
 * `resolveDeviceId` reads the stored one FIRST and never asks when it is there,
 * so the command's own reply was false in the normal case:
 *
 * > token saved. The channel resolves the matching device ID from
 * > /account/whoami on its next start.
 *
 * A channel that has run before HAS a stored device id, so the next start built
 * a Rust-crypto client claiming to be the old device while the homeserver
 * considered the token to be a new one — the shape `server/src/state.ts` warns
 * about in its own words, a bot that "will appear to ignore people in encrypted
 * rooms", with nothing in the log. And the whoami call it skipped is also where
 * a token belonging to a DIFFERENT ACCOUNT is caught.
 *
 * The three-argument `configure` has always cleared both keys when the user id
 * changes — *"Replacing the account: the stored token and device belong to the
 * old one"* — so the sentence existed and the token-only arm did not say it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { credentialUpdatesForToken } from '../src/config.ts';

const EXTENSION = readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server/src/server.ts', import.meta.url), 'utf8');

describe('credentialUpdatesForToken', () => {
  it('writes the token', () => {
    assert.equal(credentialUpdatesForToken('syt_abc')['PRINNY_ACCESS_TOKEN'], 'syt_abc');
  });

  it('clears the device id — `null` is updateEnv\'s delete', () => {
    const updates = credentialUpdatesForToken('syt_abc');
    assert.ok('PRINNY_DEVICE_ID' in updates, 'the key has to be MENTIONED, or nothing removes it');
    assert.equal(updates['PRINNY_DEVICE_ID'], null);
  });

  it('touches nothing else', () => {
    // Not the homeserver, not the user id, and not the password: a token is one
    // credential and `configure token` is the arm that sets only that one.
    assert.deepEqual(Object.keys(credentialUpdatesForToken('syt_abc')).sort(), [
      'PRINNY_ACCESS_TOKEN',
      'PRINNY_DEVICE_ID',
    ]);
  });
});

describe('AN3 — the wiring, and the coupling that makes it matter', () => {
  it('the token arm goes through the helper', () => {
    const arm = EXTENSION.slice(EXTENSION.indexOf("if (rest[0] === 'token')"), EXTENSION.indexOf("if (rest.length < 3)"));
    assert.match(arm, /updateEnv\(credentialUpdatesForToken\(token\)\)/);
    assert.doesNotMatch(arm, /updateEnv\(\{ PRINNY_ACCESS_TOKEN: token \}\)/, 'the old form left the device behind');
  });

  it('…and says what it did, because the old reply said the opposite', () => {
    const arm = EXTENSION.slice(EXTENSION.indexOf("if (rest[0] === 'token')"), EXTENSION.indexOf("if (rest.length < 3)"));
    assert.match(arm, /device ID cleared/i);
  });

  it('the account-switch arm still clears both — the control', () => {
    const arm = EXTENSION.slice(EXTENSION.indexOf('const switchingAccount'));
    assert.match(arm.slice(0, 600), /PRINNY_ACCESS_TOKEN: null, PRINNY_DEVICE_ID: null/);
  });

  it('resolveDeviceId still prefers a stored id, which is why the clear is the fix', () => {
    // The coupling, pinned. If this ever becomes "verify the stored id against
    // whoami", the clear stops being load-bearing and this test says so.
    const fn = SERVER.slice(SERVER.indexOf('async function resolveDeviceId'));
    assert.match(fn.slice(0, 400), /if \(creds\.deviceId\) return creds\.deviceId;/);
    const whoamiAt = fn.indexOf('account/whoami');
    const returnAt = fn.indexOf('return creds.deviceId;');
    assert.ok(returnAt >= 0 && returnAt < whoamiAt, 'the stored id short-circuits the lookup');
  });

  it('…and the lookup is what checks the token belongs to this account', () => {
    const fn = SERVER.slice(SERVER.indexOf('async function resolveDeviceId'));
    assert.match(fn.slice(0, 2_000), /the access token belongs to \$\{body\.user_id\}/);
  });
});
