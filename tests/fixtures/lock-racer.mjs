/**
 * One competitor in the `access.json` two-writer race, as a real process.
 *
 * The race this exists to prove is BETWEEN PROCESSES — the pi extension and the
 * sidecar are two OS processes with two heaps, so nothing in one JavaScript
 * realm can reproduce it. Threads would not do either: the bug is a file's
 * contents, not a shared variable.
 *
 *   node lock-racer.mjs <impl.ts> <target.json> <iterations> <locked|unlocked> <holdMs> <startFile>
 *
 * Each iteration is read → wait → write, which is exactly the shape of
 * `updateAccess` and `gate`. `holdMs` widens the window on purpose: without it
 * the interleaving is real but rare, and a control that only sometimes shows
 * the bug is not a control.
 *
 * Every racer spins until `startFile` exists, so the processes enter the loop
 * together rather than in spawn order.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [implPath, target, iterationsRaw, mode, holdRaw, startFile] = process.argv.slice(2);
const iterations = Number(iterationsRaw);
const holdMs = Number(holdRaw);

const { withFileLock } = await import(pathToFileURL(implPath).href);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read, wait, write - tmp-then-rename with a per-process temp path, exactly
 * what `writeAccess` and `saveAccess` do.
 *
 * Writing `target` in place instead would let the UNLOCKED control fail as a
 * JSON parse error rather than as a lost update, and a control that crashes
 * proves the wrong thing. The atomic write leaves the lost update as the only
 * way this can go wrong, which is the failure under test.
 */
function bump() {
  const before = JSON.parse(readFileSync(target, 'utf8'));
  sleepSync(holdMs);
  before.count += 1;
  before.writers[String(process.pid)] = (before.writers[String(process.pid)] ?? 0) + 1;
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(before));
  renameSync(tmp, target);
}

while (!existsSync(startFile)) sleepSync(1);

for (let i = 0; i < iterations; i += 1) {
  if (mode === 'locked') withFileLock(target, bump, { onWarn: () => undefined });
  else bump();
}
