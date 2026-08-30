/**
 * The persona's own reach into Matrix: a status it chooses, and the room topic.
 *
 * With a persona active (`vendor/pi-persona`) the bot already wears a name and a
 * face and speaks in a voice. These are the two things it can *do* to the room
 * that a person actually sees, and the point of them is immersion: a character
 * who occasionally says what they are up to reads as present, rather than as a
 * process that answers when poked.
 *
 * ## The whole difficulty is that "occasionally" is not a thing a prompt can
 * ## promise
 *
 * A model told "do this from time to time" will do it every turn for a while and
 * then not at all, and on this stack there is a second reason not to leave it to
 * wording: presence writes are rate-limited by the homeserver (measured — see
 * presence-status.ts), so a chatty persona would simply be refused, and the model
 * would read the refusal as a broken tool.
 *
 * So the bound is HERE, in code, and the prompt is told about the bound rather
 * than asked to respect one. A call inside the cooldown is not an error: it is
 * refused with the time remaining, in a sentence that says the refusal is normal
 * and not worth retrying or apologising for. That distinction matters — a model
 * that reads "refused" as "failed" starts explaining itself to the user, which
 * is worse than the spam.
 *
 * The two windows differ because the acts differ. A status is ambient — it sits
 * under a display name and nobody is notified. A topic is a STATE EVENT: it
 * lands in the timeline, every client shows it, and in some rooms it pings.
 * Topics therefore get a much longer leash than statuses.
 */

/** A persona-set status is ambient; nobody is notified. */
export const STATUS_COOLDOWN_MS = 10 * 60_000;
/** A topic change is a state event in the timeline. Far more intrusive. */
export const TOPIC_COOLDOWN_MS = 60 * 60_000;

/** Matrix status lines render inline; a topic gets a line of its own. */
export const MAX_PERSONA_STATUS = 60;
export const MAX_TOPIC = 200;

export type ImmersionAct = 'status' | 'topic';

export interface Verdict {
  allowed: boolean;
  /** What to tell the model. Empty when allowed. */
  reason: string;
  /** Milliseconds until this act is allowed again. */
  waitMs: number;
}

export function cooldownFor(act: ImmersionAct): number {
  return act === 'topic' ? TOPIC_COOLDOWN_MS : STATUS_COOLDOWN_MS;
}

function humanWait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return 'about a minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'about an hour' : `${hours} hours`;
}

/**
 * May this act run now?
 *
 * `lastAt` is when it last ran, or `undefined` for never — 0 is a real time. The refusal sentence
 * is deliberately not phrased as a failure — see this file's header.
 */
export function check(
  act: ImmersionAct,
  lastAt: number | undefined,
  now: number,
): Verdict {
  const cooldown = cooldownFor(act);
  // `undefined` means never — NOT `!lastAt`. A timestamp of 0 is a real time
  // (and the one every test reaches for), and the falsy check quietly turned it
  // into "never ran", so the very first cooldown could not be tested.
  if (lastAt === undefined || lastAt === null) return { allowed: true, reason: '', waitMs: 0 };
  const since = now - lastAt;
  if (since >= cooldown) return { allowed: true, reason: '', waitMs: 0 };
  const waitMs = cooldown - since;
  return {
    allowed: false,
    waitMs,
    reason:
      `Not yet — the ${act} was set ${humanWait(since)} ago and changes are limited to one per ` +
      `${humanWait(cooldown)} so the room is not spammed. This is a normal refusal, not a failure: ` +
      `carry on with what you were doing and do not mention it or retry. You can set it again in ` +
      `${humanWait(waitMs)}.`,
  };
}

export function clampStatus(text: string): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_PERSONA_STATUS ? flat : `${flat.slice(0, MAX_PERSONA_STATUS - 1)}…`;
}

export function clampTopic(text: string): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_TOPIC ? flat : `${flat.slice(0, MAX_TOPIC - 1)}…`;
}

/**
 * The nudge, added to the system prompt only when a persona is active AND the
 * channel is running.
 *
 * Absent otherwise, for two different reasons. With no channel the acts cannot
 * happen at all and describing them is dead tokens. With no persona they are
 * simply not wanted: a session with no character to be has no business setting a
 * mood on somebody's Matrix room, and the neutral voice writing "Crystal is
 * reading" would be strange.
 *
 * Written to a model that has ALREADY been told, by the persona block, that it
 * is a person rather than a program — so it is phrased as something they might
 * do, and is explicit that not doing it is the normal case. The counterweight
 * sentence is the important one: without it a model reads any mention of a
 * capability as an instruction to exercise it.
 */
export function immersionNudge(personaName: string, canSetTopic: boolean): string {
  const topicLine = canSetTopic
    ? `\n- \`prinny(action: "topic", { topic })\` renames the room's subject line. This one is ` +
      `LOUD — it is a state event, it appears in the timeline for everyone, and it is limited to ` +
      `one change an hour. Reach for it when the room's subject has genuinely changed, not for a mood.`
    : '';
  return `# Being present on Matrix

You are reachable on Matrix, and ${personaName} is a person there rather than a process that answers when poked. Two small things make that read as true:

- \`prinny(action: "status", { text })\` sets the line under your name — what you are doing, or how you are. It is ambient: nobody is notified, and it is limited to one change every ten minutes.${topicLine}

**Doing neither is the normal case.** These are not a checklist and there is nothing to keep up to date. Set a status when one would be true and worth someone glancing at — you have settled into a long piece of work, the mood of the conversation turned, you are waiting on something. Most turns warrant nothing at all, and a status that changes every few minutes is worse than none, because it stops meaning anything.

If a change is refused because it is too soon, that is normal and expected. Do not retry it, do not apologise for it, and do not mention it to the user — just carry on with what you were actually doing.`;
}
