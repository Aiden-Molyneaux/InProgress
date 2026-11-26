import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipLine, stepRef } from '../../core/step-ref';
import type { DB } from '../db/connection';
import { write, type Ctx } from '../db/tx';
import { getSend, intendSend, markTrying, moveSend, sendByRetryKey, type LeadSend } from '../repo/leadSends';
import { quietEndToday } from './morning';
import { SendWaits } from './sends';
import { quietHours, voiceCap } from './settings';

/*
 * The Voice (lead stage 1, #743, task 11): what is Aiden's leaves as one line to the Voice's routine, by its webhook. A line
 * is a lead_sends row of kind voice_line, target 'webhook'; this is the sender's `webhook` dep. A project's lines are
 * gathered: when its oldest is three minutes old (or a morning line waits) every intended line of the project goes out as
 * one POST, each line ending with its own [s<id>], and all of them move to done together with the HTTP status. At most
 * `voice-cap` POSTs a project a day; nothing in quiet hours. The webhook's address and key live in <home>/lead/voice.json,
 * read only here, and never printed: a log line or an error names it "the Voice's webhook".
 */

/** How long a project's lines are gathered before they go: the age of its oldest. */
export const VOICE_GATHER_MS = 3 * 60 * 1000;
/** How long the POST may take. */
export const VOICE_TIMEOUT_MS = 30_000;
/** How much of an ask's text a line keeps. */
export const VOICE_ASK_CUT = 160;
/** The actor of the Voice's own writes. */
const ACTOR = 'inprogress:voice';

export interface VoiceConfig {
  url: string;
  key: string;
}

/** Where the webhook's address and key live. */
export const voiceFile = (home: string): string => join(home, 'lead', 'voice.json');

/**
 * The webhook's address and key, or undefined when the file is not there. A file that cannot be read as `{ url, key }` is a
 * SendWaits (lines wait, and the sender logs it): its message says why without quoting the file.
 */
export function readVoiceConfig(home: string): VoiceConfig | undefined {
  let text: string;
  try {
    text = readFileSync(voiceFile(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SendWaits(`the Voice's webhook file could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    // The parse error would quote the file, and so the key: the reason is said without it.
    throw new SendWaits("the Voice's webhook file is not JSON");
  }
  const o = v as { url?: unknown; key?: unknown } | null;
  if (o === null || typeof o !== 'object' || typeof o.url !== 'string' || typeof o.key !== 'string' || !/^https?:\/\//i.test(o.url.trim()) || o.key.trim() === '') {
    throw new SendWaits("the Voice's webhook file needs a url (http or https) and a key");
  }
  return { url: o.url.trim(), key: o.key.trim() };
}

/** Whether the Voice is set up: its webhook file is there and reads. */
export function voiceSetUp(home: string): boolean {
  try {
    return readVoiceConfig(home) !== undefined;
  } catch {
    // A file that does not read is not set up: what is wrong with it is logged by the sender when a line waits.
    return false;
  }
}

/** The line a status read prints when the Voice is not set up. */
export const VOICE_NOT_SET_UP = 'The Voice is not set up: its lines wait.';

/** Whether a local time (minutes of the day) is inside quiet hours `from`-`to` (to excluded; equal ends are no quiet hours). */
export function inQuiet(minute: number, q: { from: number; to: number }): boolean {
  if (q.from === q.to) return false;
  return q.from < q.to ? minute >= q.from && minute < q.to : minute >= q.from || minute < q.to;
}

/** Where the Voice's day starts: the latest end of quiet hours at or before now. */
export function voiceDayStart(now: string, quietTo: number): string {
  const end = quietEndToday(now, quietTo);
  if (end <= now) return end;
  // One calendar day back, at the same local time: a day with a clock change is not 24 hours long.
  const d = new Date(end);
  d.setDate(d.getDate() - 1);
  return d.toISOString();
}

/** How many POSTs the project's lines made since `since`: lines that went together share their done time. */
export function voicePostsSince(db: DB, projectId: number, since: string): number {
  return db
    .prepare("SELECT COUNT(DISTINCT done_at) FROM lead_sends WHERE project_id = ? AND kind = 'voice_line' AND state = 'done' AND done_at >= ?")
    .pluck()
    .get(projectId, since) as number;
}

/** A morning line (task 10 writes it, retry key `morning:<project>:<date>`): it goes at once. */
export const isMorningLine = (s: LeadSend): boolean => s.retryKey !== null && s.retryKey.startsWith('morning:');

/** A line as it is sent: its text, then its send id. */
export const voiceText = (s: LeadSend): string => `${s.body.trim()} [s${s.id}]`;

/** What the webhook sends: the project's gathered lines, a blank line between. */
export const voiceMessage = (lines: readonly LeadSend[]): string => lines.map(voiceText).join('\n\n');

export interface VoiceOptions {
  home: string;
  /** The HTTP client; the global fetch unless a test gives another. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The sender's `webhook` dep. Called for one intended line, it sends every intended line of that line's project in one POST
 * when they are ready, or throws SendWaits (nothing sent): not set up, quiet hours, still gathering, past the day's cap, a
 * 5xx or a network failure. A 2xx moves them all to done with the status. Any other status throws a plain error, so the
 * sender looks the line up, and, as a line to the Voice cannot be found, it becomes unknown with an unknown_send item.
 */
/**
 * Whether the project of `send` has lines ready to go: the webhook's config and the lines, or why they wait (not set up,
 * quiet hours, still gathering, past the day's cap). A read. A webhook file that does not read throws SendWaits.
 */
export function voiceReadiness(ctx: Ctx, home: string, send: LeadSend): { wait: string } | { config: VoiceConfig; lines: LeadSend[] } {
  const config = readVoiceConfig(home);
  if (config === undefined) return { wait: 'the Voice is not set up' };
  const now = ctx.now();
  const quiet = quietHours(ctx.db, send.projectId);
  const local = new Date(now);
  if (inQuiet(local.getHours() * 60 + local.getMinutes(), quiet)) return { wait: 'quiet hours' };
  const lines = (ctx.db
    .prepare("SELECT id FROM lead_sends WHERE project_id = ? AND kind = 'voice_line' AND state = 'intended' AND (result IS NULL OR id = ?) ORDER BY created_at, id")
    .pluck()
    .all(send.projectId, send.id) as number[]).flatMap((id) => getSend(ctx.db, id) ?? []);
  if (lines.length === 0) return { wait: 'no line to send' };
  const morning = lines.some(isMorningLine);
  const oldest = Math.min(...lines.map((l) => Date.parse(l.createdAt)));
  if (!morning && Date.parse(now) - oldest < VOICE_GATHER_MS) return { wait: 'gathering' };
  if (!morning && voicePostsSince(ctx.db, send.projectId, voiceDayStart(now, quiet.to)) >= voiceCap(ctx.db, send.projectId)) {
    return { wait: "past the day's cap: the lines wait for the morning" };
  }
  return { config, lines };
}

/** The sender's two Voice deps: whether a project's lines are ready (asked before anything is written), and the webhook. */
export function createVoice(ctx: Ctx, opts: VoiceOptions): { ready: (send: LeadSend) => boolean; webhook: (send: LeadSend) => Promise<string> } {
  return {
    ready: (send) => {
      try {
        return !('wait' in voiceReadiness(ctx, opts.home, send));
      } catch {
        // A webhook file that does not read: the webhook runs, and the sender logs why the line waits.
        return true;
      }
    },
    webhook: createVoiceWebhook(ctx, opts),
  };
}

export function createVoiceWebhook(ctx: Ctx, opts: VoiceOptions): (send: LeadSend) => Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  return async (send) => {
    const ready = voiceReadiness(ctx, opts.home, send);
    if ('wait' in ready) throw new SendWaits(ready.wait, true);
    const { config, lines } = ready;
    // Never let the address or the key reach a log line or an error.
    const scrub = (text: string): string => text.split(config.url).join("the Voice's webhook").split(config.key).join('[key]');
    const others = lines.filter((l) => l.id !== send.id).map((l) => l.id);
    // The rest are tried with this one: written before the POST, so a restart looks them up rather than sending them again.
    write(ctx, ACTOR, () => others.forEach((id) => markTrying(ctx.db, id, true)));
    const untry = (): void => write(ctx, ACTOR, () => others.forEach((id) => markTrying(ctx.db, id, false)));
    let status: number;
    try {
      const res = await doFetch(config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
        body: JSON.stringify({ text: voiceMessage(lines) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? VOICE_TIMEOUT_MS),
      });
      status = res.status;
      // The reply is read and dropped: it may echo the address.
      await res.text().catch(() => '');
    } catch (err) {
      untry();
      const e = err as { name?: string; cause?: { code?: string } };
      const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'did not answer in time' : `could not be reached (${e.cause?.code ?? e.name ?? 'error'})`;
      throw new SendWaits(scrub(`the Voice's webhook ${why}`));
    }
    if (status >= 500) {
      untry();
      throw new SendWaits(`the Voice's webhook answered ${status}`);
    }
    if (status < 200 || status >= 300) throw new Error(`the Voice's webhook refused the lines: HTTP ${status}`);
    const result = String(status);
    const at = ctx.now();
    write(ctx, ACTOR, () => lines.forEach((l) => moveSend(ctx.db, l.id, ['intended'], 'done', { result, now: at })));
    return result;
  };
}

/** Writes a voice line as intended, once per retry key, inside the caller's write. */
function intendLine(db: DB, input: { projectId: number; itemId?: number | null; retryKey: string; body: string }, now: string): void {
  if (sendByRetryKey(db, input.retryKey) !== undefined) return;
  intendSend(db, { projectId: input.projectId, itemId: input.itemId ?? null, kind: 'voice_line', target: 'webhook', retryKey: input.retryKey, body: input.body }, now);
}

/** A bring's line (scene 2): the project, the step, the ask, and what the lead would pick. Retry key `voice:bring:d<id>`. */
export function bringVoiceLine(input: { projectName: string; stepId: number | null; stepTitle: string | null; askText: string; wouldHave: string }): string {
  const step = input.stepId === null ? '' : `${stepRef(input.stepId, input.stepTitle ?? undefined)}. `;
  const pick = input.wouldHave.trim() === '' ? 'Give your answer.' : `I would pick: ${input.wouldHave.trim()} Say "yes" to that, or give your own answer.`;
  return `Yours, ${clipLine(input.projectName, 80)}: ${step}${clipLine(input.askText, VOICE_ASK_CUT)}\n${pick}`;
}

/** A held action's line. Retry key `voice:held:<item id>`. */
export function heldVoiceLine(input: { projectName: string; stepId: number | null; what: string }): string {
  const who = input.stepId === null ? 'a session' : `#${input.stepId}`;
  const what = input.what.trim().replace(/\.+$/, '');
  return `Held, ${clipLine(input.projectName, 80)}: ${who} wants to do ${what.charAt(0).toLowerCase()}${what.slice(1)}. Say "go ahead" or "not yet".`;
}

/** Intends a bring's voice line, inside the caller's write. */
export function intendBringLine(db: DB, input: { projectId: number; itemId: number; eventId: number; projectName: string; stepId: number | null; stepTitle: string | null; askText: string; wouldHave: string }, now: string): void {
  intendLine(db, { projectId: input.projectId, itemId: input.itemId, retryKey: `voice:bring:d${input.eventId}`, body: bringVoiceLine(input) }, now);
}

/** Intends a held item's voice line, inside the caller's write. */
export function intendHeldLine(db: DB, input: { projectId: number; itemId: number; projectName: string; stepId: number | null; what: string }, now: string): void {
  intendLine(db, { projectId: input.projectId, itemId: input.itemId, retryKey: `voice:held:${input.itemId}`, body: heldVoiceLine(input) }, now);
}


/**
 * An old ask's line (task 17, scene 6): the project, where the ask is in that project's old asks, its step, its age in
 * whole days, then the lead's reading when one is stored, and the words that ask for his answer. Retry key
 * `voice:old:<item id>`.
 */
export function oldAskVoiceLine(input: { projectName: string; index: number; total: number; stepId: number; stepTitle: string | null; days: number; reading: string | null }): string {
  const reading = input.reading === null || input.reading.trim() === '' ? '' : `${sentenceOf(input.reading)} `;
  return `${clipLine(input.projectName, 80)}, ${input.index} of ${input.total}: ${stepRef(input.stepId, input.stepTitle ?? undefined)}, ${input.days} day${input.days === 1 ? '' : 's'} old.\n${reading}Say your answer.`;
}

/** The reading as a sentence: a period added when it ends in none of . ! or ?. */
const sentenceOf = (text: string): string => {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** The line that says the old asks are all answered. Retry key `voice:old:done:<date>`. */
export const OLD_ASKS_DONE_LINE = 'The old asks are done.';

/** Where every old-ask retry key starts; the done line's keys start with OLD_DONE_KEY_PREFIX inside it. */
export const OLD_KEY_PREFIX = 'voice:old:';
export const OLD_DONE_KEY_PREFIX = `${OLD_KEY_PREFIX}done:`;
/** SQL LIKE patterns for the two: an old ask's line is `LIKE OLD_KEY_LIKE AND NOT LIKE OLD_DONE_KEY_LIKE`. */
export const OLD_KEY_LIKE = `${OLD_KEY_PREFIX}%`;
export const OLD_DONE_KEY_LIKE = `${OLD_DONE_KEY_PREFIX}%`;

/** An old ask's line's retry key: `voice:old:<item id>` for its first line, `voice:old:<item id>:<n>` for its n-th. */
export const oldLineKey = (itemId: number, n = 1): string => (n <= 1 ? `${OLD_KEY_PREFIX}${itemId}` : `${OLD_KEY_PREFIX}${itemId}:${n}`);
/** The done line's retry key for a day. */
export const oldDoneKey = (date: string): string => `${OLD_DONE_KEY_PREFIX}${date}`;

/** Intends an old ask's n-th voice line (oldLineKey), inside the caller's write. */
export function intendOldAskLine(db: DB, input: { projectId: number; itemId: number; body: string; n?: number }, now: string): void {
  intendLine(db, { projectId: input.projectId, itemId: input.itemId, retryKey: oldLineKey(input.itemId, input.n), body: input.body }, now);
}

/** Intends the line that the old asks are done, once a day (oldDoneKey), inside the caller's write. */
export function intendOldAsksDoneLine(db: DB, input: { projectId: number; date: string }, now: string): void {
  intendLine(db, { projectId: input.projectId, retryKey: oldDoneKey(input.date), body: OLD_ASKS_DONE_LINE }, now);
}
