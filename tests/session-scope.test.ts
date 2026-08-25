/**
 * Which teardowns end the channel, and which only end a session.
 *
 * THE LOAD-BEARING TEST is "`reload` stops, like `quit`". Everything about AP1
 * is an argument for keeping the sidecar alive across a teardown, and `reload`
 * is the one teardown that looks exactly like the others and must not be. pi's
 * `ResourceLoader.reload()` calls `clearExtensionCache()`, which bumps the
 * generation `isCurrentCacheToken` compares — so on `/reload` the extension
 * module is RE-EVALUATED, the new instance's `child` is `null`, and a detach
 * would leave a sidecar nobody can reach logged in to Matrix. The replacement
 * then spawns a second bot onto the same Olm crypto store, which
 * `server/src/account-lock.ts` refuses, and the channel is dead until the
 * process restarts.
 *
 * Its control is "`new` detaches": a rule that stopped for everything would
 * pass the test above for the wrong reason, and would also be the bug this pass
 * exists to fix.
 *
 * The third pair is the one that is easy to get wrong in the other direction:
 * an UNRECOGNISED reason stops. The failure of guessing wrong towards `stop` is
 * a thirty-second channel restart; the failure of guessing wrong towards
 * `detach` is unrepairable key state. A reason pi adds in a later version must
 * land on the cheap side.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SESSION_REPLACEMENT_REASONS,
  replacedSessionMessage,
  shutdownDisposition,
  startDisposition,
} from '../src/session-scope.ts';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe('shutdownDisposition — what ends the channel', () => {
  it('stops on reload, because the module is re-evaluated and the handle is lost', () => {
    assert.equal(shutdownDisposition('reload'), 'stop');
  });

  it('stops on quit, because the process is going', () => {
    assert.equal(shutdownDisposition('quit'), 'stop');
  });

  it('detaches on a session replacement, which is the whole point', () => {
    assert.equal(shutdownDisposition('new'), 'detach');
    assert.equal(shutdownDisposition('resume'), 'detach');
    assert.equal(shutdownDisposition('fork'), 'detach');
  });

  it('stops on anything it does not recognise, including a missing reason', () => {
    // An older pi that does not populate `reason`, or a newer one that invents
    // a sixth. Both must cost a restart rather than an orphaned sidecar.
    assert.equal(shutdownDisposition(undefined), 'stop');
    assert.equal(shutdownDisposition(null), 'stop');
    assert.equal(shutdownDisposition(''), 'stop');
    assert.equal(shutdownDisposition('hibernate'), 'stop');
    // Not a string at all, which is what a shape change would look like.
    assert.equal(shutdownDisposition({ reason: 'new' }), 'stop');
    assert.equal(shutdownDisposition(0), 'stop');
  });

  it('agrees with the exported list, so the rule is stated once', () => {
    for (const reason of SESSION_REPLACEMENT_REASONS) {
      assert.equal(shutdownDisposition(reason), 'detach', reason);
    }
    assert.ok(!SESSION_REPLACEMENT_REASONS.includes('reload'));
    assert.ok(!SESSION_REPLACEMENT_REASONS.includes('quit'));
  });
});

describe('startDisposition — the far side of a detach', () => {
  it('reattaches only when the channel actually survived', () => {
    assert.equal(startDisposition('new', true), 'reattach');
    assert.equal(startDisposition('resume', true), 'reattach');
    assert.equal(startDisposition('fork', true), 'reattach');
  });

  /**
   * The reason alone does not settle it. A `session_start` with reason `new`
   * arrives on a channel that is up (the ordinary case since AP1) and on one
   * that is not — the sidecar exited on its own between the two events, or it
   * never came up because the homeserver is down. Reattaching to nothing would
   * leave the bot off Matrix for the rest of the session with a pill claiming
   * otherwise.
   */
  it('starts when the reason says replacement but the channel is gone', () => {
    assert.equal(startDisposition('new', false), 'start');
    assert.equal(startDisposition('resume', false), 'start');
    assert.equal(startDisposition('fork', false), 'start');
  });

  it('starts on a cold open however the channel looks', () => {
    assert.equal(startDisposition('startup', false), 'start');
    assert.equal(startDisposition('reload', false), 'start');
    // `reload` re-evaluates the module, so `channelRunning` is false there in
    // practice; asserted with `true` anyway, because this function must not be
    // the thing that decides a reload may reattach.
    assert.equal(startDisposition('reload', true), 'start');
    assert.equal(startDisposition('startup', true), 'start');
    assert.equal(startDisposition(undefined, true), 'start');
  });
});

describe('replacedSessionMessage — what the sender is told', () => {
  it('says the answer is not coming, and that asking again works', () => {
    const message = replacedSessionMessage();
    assert.match(message, /not coming/);
    assert.match(message, /ask again/i);
  });

  /**
   * Its three neighbours — `undeliveredMessage`, `unansweredMessage` and
   * `abandonedCompactionMessage` — all end by naming an action. This one must
   * NOT borrow the compaction one's ending: `abandonedCompactionMessage` says
   * "ask again once I am back", and after a detach the bot never went anywhere.
   * Telling someone to wait for a return that already happened sends them away
   * from a working channel.
   */
  it('does not tell the sender to wait for a return that already happened', () => {
    assert.doesNotMatch(replacedSessionMessage(), /once I am back/i);
    assert.match(replacedSessionMessage(), /still here/i);
  });

  it('does not invent a cause', () => {
    // The extension is the thing performing the replacement, so unlike the
    // undelivered sweep it knows exactly what happened and says only that.
    assert.doesNotMatch(replacedSessionMessage(), /may have been|might have|possibly/i);
  });
});

/**
 * The rule is only worth having if the handler dispatches on it, and this file
 * cannot import `extensions/index.ts` — it pulls in `@earendil-works/pi-tui`,
 * `@earendil-works/pi-ai` and `typebox`, none of which resolve under the bare
 * `node --experimental-strip-types --test` this suite runs on. Six other suites
 * in this directory assert on that file's SOURCE TEXT for the same reason.
 */
describe('AP1 — the extension actually reads the reason', () => {
  const source = readFileSync(join(PACKAGE_ROOT, 'extensions', 'index.ts'), 'utf8');

  /**
   * Comments out, before asking what the code does.
   *
   * Without this the assertions below are about the PROSE as much as the
   * program: `detachSession`'s body explains itself by naming `stopChannel`
   * ("the same call `stopChannel` makes, for the same reason"), which is the
   * comment doing its job and would have been read as the function calling it.
   * A guard that fires on its own documentation is a guard nobody keeps.
   */
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('routes session_shutdown through shutdownDisposition', () => {
    assert.match(source, /shutdownDisposition\(reason\) === 'detach'/);
    assert.match(source, /detachSession\(reason\)/);
  });

  it('routes session_start through startDisposition', () => {
    assert.match(source, /startDisposition\(reason, Boolean\(child\?\.running\)\) === 'reattach'/);
  });

  /**
   * The one thing a detach must not do. `child`, `lifecycle` and `shuttingDown`
   * are the sidecar's; touching any of them here is a stop wearing a detach's
   * name, and it would take the channel down on exactly the path this pass
   * exists to keep it up on.
   */
  it('detachSession never touches the sidecar', () => {
    const body = code(
      source.slice(
        source.indexOf('function detachSession('),
        source.indexOf('function reattachSession(')
      )
    );
    assert.ok(body.length > 0, 'detachSession must precede reattachSession');
    assert.doesNotMatch(body, /\bchild\b\s*=/);
    assert.doesNotMatch(body, /\blifecycle\b/);
    assert.doesNotMatch(body, /shuttingDown/);
    assert.doesNotMatch(body, /stopChannel/);
  });

  /**
   * pi emits `session_start` TWICE for one `/new` — `bindExtensions` runs once
   * in `createRuntime` and again in `finishSessionReplacement`. Measured against
   * a real pi in `--mode rpc`: one `session_shutdown`, one factory call, then
   * two `session_start` events with reason `new`. So the reattach path is run
   * twice for every replacement and nothing in it may accumulate.
   */
  it('reattachSession is safe to run twice, which pi does', () => {
    const body = code(
      source.slice(
        source.indexOf('function reattachSession('),
        source.indexOf('function requireChannel(')
      )
    );
    assert.ok(body.length > 0, 'reattachSession must precede requireChannel');
    // `armDeliverySweep` is itself `if (deliveryTimer) return`, and it is the
    // only mutation here. Anything that pushed, appended or incremented would
    // double on the second call.
    assert.doesNotMatch(body, /\.push\(|\.add\(|\+\+|\+=/);
  });
});
