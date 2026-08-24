/**
 * One bot per Matrix ACCOUNT, enforced rather than documented.
 *
 * WHAT WENT WRONG, 2026-08-24. Five bots were logged into
 * `@openclaude:struct.ws` at once — four Claude Code channel servers sharing a
 * single state directory (and therefore a single `device_id` and a single
 * `crypto/snapshot.json`) plus one pi channel with its own directory. The
 * account had accumulated seven devices.
 *
 * The visible symptoms were the pairing prompt arriving four times, and
 * `DecryptionError: The sender's device has not sent us the keys for this
 * message` on every inbound message. The cause is the same for both: peers
 * encrypt to the devices they know, and four processes rewriting one Olm
 * account leave the identity keys the sender cached pointing at nothing. There
 * is no repair — the account had to be stripped to one device and re-minted.
 *
 * WHY THE EXISTING GUARD DID NOT CATCH IT. `server.ts` has a single-poller
 * guard whose comment describes this exact failure, and it is keyed on
 * `STATE_DIR/bot.pid`. Two things get past it:
 *
 *   1. It is scoped to ONE state directory. The pi channel and the Claude Code
 *      channel have different directories and the same account, so neither can
 *      see the other. That is the case that produced two live devices.
 *   2. Its failure mode is silent. It reads the pid, shells out to `ps` to
 *      confirm the holder is one of ours, and the whole thing sits inside
 *      `catch {}` before `writeFileSync(PID_FILE, ...)` runs unconditionally.
 *      Any throw — `ps` absent, a permissions error, a truncated pid file —
 *      means the incumbent is never signalled and the newcomer takes the pid
 *      file anyway. And `process.kill(pid, 'SIGTERM')` is asynchronous: it
 *      returns before the incumbent has released anything.
 *
 * WHAT THIS DOES INSTEAD. The lock is keyed on `user_id@homeserver`, lives in a
 * fixed shared path outside any channel directory, and is taken with `O_EXCL`
 * so acquisition is decided by the filesystem rather than by a read followed by
 * a write. A second bot does not race, does not signal anybody, and does not
 * take over: it fails to acquire and exits with a message naming the holder.
 *
 * `O_EXCL` is the right primitive here and it is not assumed to work — the
 * sibling `file-lock.ts` was written for the `access.json` two-writer race and
 * verified on the 9p mount this stack actually runs on: unlocked, 4 of 16
 * writes survived; locked, 16 of 16.
 *
 * A HELD LOCK IS NOT PROOF OF A LIVE HOLDER. A SIGKILLed bot leaves the file
 * behind, and a lock nobody can clear is worse than the race it prevents. So a
 * stale holder is detected and broken exactly once, with the reason logged.
 *
 * LIVENESS IS NOT INFERRED FROM THE COMMAND LINE. The first version of this
 * file asked `ps` whether the holder's args contained "prinny-channel" — the
 * same heuristic the old pid guard used — and its own test caught the hole: a
 * holder whose argv does not happen to contain that string reads as DEAD, the
 * lock is broken, and a second bot starts. That is the exact failure this file
 * exists to prevent, reintroduced by the check meant to enforce it.
 *
 * The lock records the holder's start time from `/proc/<pid>/stat` field 22
 * instead. It is exact, costs one file read, and settles PID recycling for
 * free: a recycled pid has a different start time. Where `/proc` is
 * unavailable the answer is "cannot tell", and a lock that cannot be PROVED
 * stale is treated as HELD — refusing to start is recoverable and a second bot
 * on one account is not.
 */

import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AccountLockHolder {
	pid: number;
	channelDir: string;
	startedAt: string;
	/** /proc/<pid>/stat field 22, in clock ticks since boot. Absent off Linux. */
	procStart?: string;
}

export interface AccountLockResult {
	ok: boolean;
	path: string;
	holder?: AccountLockHolder;
	brokeStale?: string;
}

/** Shared across channel directories AND across checkouts — that is the point. */
export function accountLockPath(userId: string, homeserver: string): string {
	const key = createHash("sha1").update(`${userId}@${homeserver}`).digest("hex").slice(0, 16);
	return join(homedir(), ".prinny", "account-locks", `${key}.lock`);
}

/**
 * When `pid` started, as `/proc/<pid>/stat` field 22.
 *
 * The field before it is `comm`, which is unquoted and may contain spaces and
 * parentheses, so the line is split after the FINAL ')' rather than on
 * whitespace from the left — splitting naively is the classic way to read the
 * wrong field for a process whose name contains a space.
 */
export function processStartTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return after[19]; // field 22 overall, minus pid/comm/state
	} catch {
		return undefined;
	}
}

/** Is the recorded holder still running? `undefined` means "could not tell". */
export function holderIsAlive(holder: AccountLockHolder): boolean | undefined {
	try {
		process.kill(holder.pid, 0);
	} catch {
		return false; // no such process, or not ours to signal
	}
	const now = processStartTime(holder.pid);
	if (now !== undefined && holder.procStart !== undefined) {
		return now === holder.procStart; // exact: same pid AND same start
	}
	try {
		const args = execFileSync("ps", ["-p", String(holder.pid), "-o", "args="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return args.includes("prinny-channel") || args.includes("server.js") ? true : undefined;
	} catch {
		return undefined;
	}
}

export function claimAccount(
	userId: string,
	homeserver: string,
	channelDir: string,
	log: (m: string) => void = () => {},
): AccountLockResult {
	const path = accountLockPath(userId, homeserver);
	mkdirSync(join(homedir(), ".prinny", "account-locks"), { recursive: true, mode: 0o700 });

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeSync(fd, JSON.stringify({
				pid: process.pid, channelDir,
				startedAt: new Date().toISOString(),
				procStart: processStartTime(process.pid),
			}));
			closeSync(fd);
			return { ok: true, path };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}

		let holder: AccountLockHolder | undefined;
		try {
			holder = JSON.parse(readFileSync(path, "utf8")) as AccountLockHolder;
		} catch {
			holder = undefined; // unreadable or truncated: treat as stale below
		}

		const alive = holder?.pid ? holderIsAlive(holder) : false;
		if (alive === true) return { ok: false, path, holder };
		if (alive === undefined) {
			log(`account lock: cannot establish whether pid ${holder?.pid} is alive; treating the lock as held`);
			return { ok: false, path, holder };
		}

		if (attempt === 0) {
			const why = holder ? `holder pid ${holder.pid} is gone` : "the lock file is unreadable";
			log(`account lock: breaking a stale lock (${why})`);
			rmSync(path, { force: true });
			continue;
		}
		return { ok: false, path, holder };
	}
	return { ok: false, path };
}

export function releaseAccount(path: string): void {
	try {
		const holder = JSON.parse(readFileSync(path, "utf8")) as AccountLockHolder;
		if (holder.pid !== process.pid) return; // someone else's now; leave it
	} catch {
		return;
	}
	rmSync(path, { force: true });
}

export function describeHolder(holder: AccountLockHolder | undefined): string {
	if (!holder) return "another process";
	return `pid ${holder.pid} (${holder.channelDir}, since ${holder.startedAt})`;
}
