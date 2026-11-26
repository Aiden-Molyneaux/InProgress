import { LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { clipLine } from '../../core/step-ref';
import { stamp } from '../../core/span';
import { hhmm, WEEKDAYS, dayTime } from './when';
import { write, type Ctx } from '../db/tx';
import { insertLeadEvent } from '../repo/leadEvents';
import { intendSend } from '../repo/leadSends';
import { getProjectById } from '../repo/projects';
import { liveProjectsWithRound, roundFirstOn } from '../repo/switches';
import { heldRef } from './hold';
import { startProviderModel } from '../lead-start';
import { leadFolderOf } from './folder';
import { parseStartBody, THREAD_GONE } from './sends';
import { leadThreadOn, quietHours } from './settings';
import { weekSentence } from './usage';

/*
 * The morning list (lead stage 1, #743, task 10): plain code, no model. At the end of quiet hours, or at the first wake
 * after it, one list per project with a lead and the round on. Lines the Voice held in the night go out with it.
 */

/** An intended send older than this is counted as not delivered. */
export const NOT_DELIVERED_AFTER_MS = 10 * 60 * 1000;
const ASK_CUT = 100;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `Thursday 26 November`, local. */
export function dayWords(iso: string): string {
  const d = new Date(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export { dayTime };
/** A local date, `2026-11-26`: the day's key in a retry key. */
export const dateKey = (iso: string): string => stamp(iso).slice(0, 10);

/** A duration as the list reads it: `70 s`, `2 min 50`, `3 min`. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r}`;
}

/** One part of the list: its name, the count in brackets when it has one, and its lines. */
export interface MorningPart {
  name: string;
  count?: number;
  lines: string[];
}

/** The list as text, and by part. `text` is '' when the day had nothing. */
export interface MorningList {
  text: string;
  parts: MorningPart[];
  yours: number;
  decided: number;
  held: number;
}

interface Titled {
  node_id: number | null;
  title: string | null;
}

/** What a send not delivered was, as the morning list names it; any other kind is named by its kind. */
const SEND_WHAT: Record<string, string> = { voice_line: 'A Voice line', carry: 'A carried answer', relay: 'A message to a session', start: 'A session start' };
/** How much of a send's first line the Not delivered line keeps. */
const SEND_GIST_CUT = 80;

/**
 * A send's gist: the first non-empty line of its body (a start's first message) after any leading `[From ...]` header,
 * whether the header stands alone on line 1 (relayText) or opens the line (leadLine), on one line and clipped.
 */
export function sendGist(kind: string, body: string): string {
  const text = kind === 'start' ? (parseStartBody(body)?.message ?? body) : body;
  const rest = text.trim().replace(/^\[From [^\]]*\]\s*/, '');
  const first = rest.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return clipLine(first, SEND_GIST_CUT);
}

const stepWords = (nodeId: number | null, title: string | null): string => (nodeId === null ? '' : title === null ? `#${nodeId}` : `#${nodeId} ${title}`);
const noStop = (text: string): string => text.trim().replace(/\.+$/, '');

/** The list's text: each part's label padded to one column, two spaces, then its lines under each other. */
function layout(header: string, parts: MorningPart[], tail: string[]): string {
  const labels = parts.map((p) => (p.count === undefined ? p.name : `${p.name} (${p.count})`));
  const width = Math.max(0, ...labels.map((l) => l.length)) + 2;
  const out = [header];
  parts.forEach((p, i) => {
    p.lines.forEach((line, j) => out.push(`${j === 0 ? labels[i]!.padEnd(width) : ' '.repeat(width)}${line}`));
  });
  out.push(...tail);
  return out.join('\n');
}

/**
 * The project's list since `since` as of `now`. A part with nothing in it is left out; a day with nothing yours, decided,
 * held, gone wrong or undelivered has no list (text ''). The week and the lead's own count never make a list alone.
 */
export function morningList(ctx: Ctx, projectId: number, since: string, now: string): MorningList {
  const db = ctx.db;
  const project = getProjectById(ctx, projectId);
  const empty: MorningList = { text: '', parts: [], yours: 0, decided: 0, held: 0 };
  if (project === undefined) return empty;
  const parts: MorningPart[] = [];

  // Yours: brought and still waiting.
  const yours = (db
    .prepare(
      `SELECT e.node_id, n.title, a.text AS ask_text, e.text AS would_have FROM lead_events e
       JOIN asks a ON a.id = e.ask_id LEFT JOIN nodes n ON n.id = e.node_id
       WHERE e.project_id = ? AND e.kind = 'bring' AND a.cleared_at IS NULL ORDER BY e.at, e.id`,
    )
    .all(projectId) as (Titled & { ask_text: string; would_have: string })[]).map(
    // A review is brought with no would-have: the lead never judges one.
    (r) => `${stepWords(r.node_id, r.title)}: ${noStop(clipLine(r.ask_text, ASK_CUT))}.${r.would_have.trim() === '' ? '' : ` I would: ${noStop(r.would_have)}.`}`,
  );
  // What he left to the lead and the round brought back to him (an aiden_said item, task 11), while it waits on him.
  yours.push(
    ...(db
      .prepare(
        `SELECT e.node_id, n.title, ld.aiden_words, e.text AS would_have FROM lead_events e
         JOIN lead_decisions ld ON ld.event_id = e.id JOIN desk_items d ON d.id = ld.item_id LEFT JOIN nodes n ON n.id = e.node_id
         WHERE e.project_id = ? AND e.kind = 'bring' AND d.kind = 'aiden_said' AND d.state = 'waiting_aiden' ORDER BY e.at, e.id`,
      )
      .all(projectId) as (Titled & { aiden_words: string | null; would_have: string })[]).map(
      (r) => `${stepWords(r.node_id, r.title)}: you left it to me ("${noStop(clipLine(r.aiden_words ?? '', ASK_CUT))}"). I would: ${noStop(r.would_have)}.`,
    ),
  );
  if (yours.length) parts.push({ name: 'Yours', count: yours.length, lines: yours });

  // Decided for you: the lead's own, not undone; product rulings first, then by time. A decision on a stopped item is left
  // out: its restart, park or done note is under Went wrong.
  const decidedRows = db
    .prepare(
      `SELECT e.id AS event_id, e.kind AS event_kind, e.node_id, n.title, d.line, d.product_ruling FROM lead_decisions d
       JOIN lead_events e ON e.id = d.event_id LEFT JOIN nodes n ON n.id = e.node_id
       WHERE d.project_id = ? AND d.said_at > ? AND e.kind NOT IN ('bring', 'answer')
         AND NOT EXISTS (SELECT 1 FROM lead_events u WHERE u.project_id = e.project_id AND u.kind = 'undo' AND u.text = 'd' || e.id)
         AND NOT EXISTS (SELECT 1 FROM desk_items si WHERE si.id = d.item_id AND si.kind = 'stopped' AND si.created_at > ?)
       ORDER BY d.product_ruling DESC, d.said_at, d.id`,
    )
    .all(projectId, since, since) as (Titled & { event_id: number; event_kind: string; line: string; product_ruling: number })[];
  if (decidedRows.length) {
    const lines = decidedRows.map((r) => {
      const undoable = r.event_kind === 'decide' || r.event_kind === 'park' || r.event_kind === 'drop';
      return `d${r.event_id} ${stepWords(r.node_id, r.title)}${r.node_id === null ? '' : ': '}${noStop(r.line)}.${undoable ? ` "undo d${r.event_id}"` : ''}`;
    });
    if (decidedRows.some((r) => r.product_ruling !== 0)) lines.unshift('Product rulings first:');
    parts.push({ name: 'Decided for you', count: decidedRows.length, lines });
  }

  // Held for you: held desk items not done, each joined to its `held` line by the session and command its ref hashes.
  const heldRows = db
    .prepare("SELECT node_id, ref FROM desk_items WHERE project_id = ? AND kind = 'held' AND state <> 'done' ORDER BY created_at, id")
    .all(projectId) as { node_id: number | null; ref: string }[];
  const heldEvents = db
    .prepare("SELECT session_id, text FROM lead_events WHERE project_id = ? AND kind = 'held'")
    .all(projectId) as { session_id: string | null; text: string }[];
  /** The command a held item's ref was made from: the line is `<command> -> <why>`, and either part may hold an arrow. */
  const commandOf = (ref: string): string | undefined => {
    for (const e of heldEvents) {
      for (let at = e.text.indexOf(' -> '); at >= 0; at = e.text.indexOf(' -> ', at + 1)) {
        const command = e.text.slice(0, at);
        if (heldRef(e.session_id, command) === ref) return command;
      }
    }
    return undefined;
  };
  const held = heldRows.map((r) => `${r.node_id === null ? 'A session' : `#${r.node_id}`} wants to ${noStop(commandOf(r.ref) ?? 'run a held command')}. Say "go ahead" or "not yet".`);
  if (held.length) parts.push({ name: 'Held for you', count: held.length, lines: held });

  // Went wrong.
  const wrong: string[] = [];
  const items = db
    .prepare(
      `SELECT kind, ref, node_id, state, outcome, created_at, done_at FROM desk_items
       WHERE project_id = ? AND created_at > ? AND (kind IN ('unknown_send') OR state = 'behind'
         OR (kind = 'stopped' AND (outcome LIKE 'RESTART%' OR outcome LIKE 'PARK%' OR outcome LIKE 'DONE%' OR outcome LIKE 'waits%' OR outcome = 'asked')))
       ORDER BY created_at, id`,
    )
    .all(projectId, since) as { kind: string; ref: string; node_id: number | null; state: string; outcome: string | null; created_at: string; done_at: string | null }[];
  for (const i of items) {
    const step = i.node_id === null ? 'A session' : `#${i.node_id}`;
    if (i.kind === 'unknown_send') wrong.push(`A send could not be confirmed (s${i.ref})${i.state === 'done' ? `; settled at ${hhmm(i.done_at ?? i.created_at)}` : ''}.`);
    else if (i.state === 'behind') wrong.push(`${step}: the lead is behind on a ${i.kind} item (${i.ref}).`);
    else {
      const stoppedAt = i.kind === 'stopped' && i.ref.includes('@') ? i.ref.slice(i.ref.indexOf('@') + 1) : i.created_at;
      const stopped = hhmm(stoppedAt);
      const at = hhmm(i.done_at ?? i.created_at);
      // A restart says how long was lost: from the stop to the restart, in whole minutes.
      const lost = Math.max(0, Math.round((Date.parse(i.done_at ?? i.created_at) - Date.parse(stoppedAt)) / 60_000));
      const o = i.outcome ?? '';
      // A restart that waits, and a park skipped, have words of their own: neither restarted nor parked anything.
      const skipped = /^PARK skipped: #\d+ is already (\w+)/.exec(o);
      const what = o.startsWith('waits')
        ? 'a restart waits for a usage reading'
        : skipped
          ? `not parked at ${at}: the step was already ${skipped[1]}`
          : o.startsWith('RESTART')
            ? `restarted at ${at}, ${Number.isNaN(lost) ? 'time lost unknown' : `${lost} minute${lost === 1 ? '' : 's'} lost`}`
            : o.startsWith('PARK')
              ? `parked at ${at}`
              : o.startsWith('DONE')
                ? `noted done at ${at}`
                : 'asked, no answer yet';
      // A park carries the word that undoes it: its decision's event id is in the outcome (`PARK d<n>`).
      const parkedBy = skipped ? null : /^PARK d(\d+)/.exec(o);
      // A park undone since carries no undo word: saying it again would find nothing to undo.
      const parkUndone = parkedBy !== null && db.prepare("SELECT 1 FROM lead_events WHERE project_id = ? AND kind = 'undo' AND text = ?").get(projectId, `d${parkedBy[1]}`) !== undefined;
      wrong.push(`${step} stopped at ${stopped}; ${what}.${parkedBy === null || parkUndone ? '' : ` "undo d${parkedBy[1]}"`}`);
    }
  }
  // A send T3 Code refused, or one that could not be read: cleared, and named here (sends.ts's `send_refused` line).
  const refusedSends = db
    .prepare("SELECT node_id, text, at FROM lead_events WHERE project_id = ? AND kind = 'send_refused' AND at > ? ORDER BY at, id")
    .all(projectId, since) as { node_id: number | null; text: string; at: string }[];
  // One whose thread T3 Code no longer has was not refused: it could not go.
  for (const r of refusedSends) {
    const gone = r.text.includes(THREAD_GONE);
    wrong.push(`${r.node_id === null ? 'A send' : `#${r.node_id}`}: a send ${gone ? `could not go at ${hhmm(r.at)} and was cleared` : `was refused at ${hhmm(r.at)} and cleared`} (${r.text}).`);
  }
  if (wrong.length) parts.push({ name: 'Went wrong', count: wrong.length, lines: wrong });

  // Not delivered.
  const undelivered = (db
    .prepare(
      `SELECT id, kind, body, state, created_at FROM lead_sends
       WHERE project_id = ? AND created_at > ? AND NOT (kind = 'voice_line' AND COALESCE(retry_key, '') LIKE 'morning:%')
         AND (state = 'unknown' OR (state = 'intended' AND created_at <= ?)) ORDER BY created_at, id`,
    )
    .all(projectId, since, new Date(Date.parse(now) - NOT_DELIVERED_AFTER_MS).toISOString()) as { id: number; kind: string; body: string; state: string; created_at: string }[]).map(
    (s) => `${SEND_WHAT[s.kind] ?? s.kind} "${sendGist(s.kind, s.body)}" (s${s.id}), ${s.state === 'unknown' ? 'not confirmed' : `not sent since ${hhmm(s.created_at)}`}.`,
  );
  if (undelivered.length) parts.push({ name: 'Not delivered', count: undelivered.length, lines: undelivered });

  if (parts.length === 0) return empty;
  const yoursN = yours.length;
  const decidedN = decidedRows.length;
  const heldN = held.length;

  // The lead's own calls.
  const turns = db
    .prepare(
      `SELECT t.duration_ms, t.started_at, t.finished_at, i.due_at FROM lead_turns t JOIN desk_items i ON i.id = t.item_id
       WHERE t.project_id = ? AND t.state = 'applied' AND t.finished_at > ?`,
    )
    .all(projectId, since) as { duration_ms: number | null; started_at: string | null; finished_at: string; due_at: string | null }[];
  if (turns.length) {
    const ms = turns.map((t) => t.duration_ms ?? (t.started_at === null ? 0 : Date.parse(t.finished_at) - Date.parse(t.started_at))).sort((a, b) => a - b);
    const median = ms.length % 2 === 1 ? ms[(ms.length - 1) / 2]! : (ms[ms.length / 2 - 1]! + ms[ms.length / 2]!) / 2;
    const late = turns.filter((t) => t.due_at !== null && t.finished_at > t.due_at).length;
    parts.push({
      name: 'The lead',
      lines: [`${turns.length} call${turns.length === 1 ? '' : 's'}, median ${duration(median)}, slowest ${duration(ms[ms.length - 1]!)}, ${late === 0 ? 'none late' : `${late} late`}.`],
    });
  }

  // The week.
  const week = weekSentence(db, now);
  if (week !== null) parts.push({ name: 'The week', lines: [week] });

  // The lid.
  const tail: string[] = [];
  const slept = db.prepare("SELECT text FROM lead_events WHERE project_id = ? AND kind = 'slept' AND at > ? ORDER BY at, id").all(projectId, since) as { text: string }[];
  for (const s of slept) {
    try {
      const gap = JSON.parse(s.text) as { from: string; to: string };
      const waited = db
        .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(state = 'behind'), 0) AS behind FROM desk_items WHERE project_id = ? AND created_at <= ? AND (done_at IS NULL OR done_at > ?)")
        .get(projectId, gap.to, gap.from) as { n: number; behind: number };
      const fate = waited.behind === 0 ? 'none was lost' : `${waited.behind} fell behind`;
      tail.push(`The laptop slept from ${hhmm(gap.from)} to ${hhmm(gap.to)}. ${waited.n} item${waited.n === 1 ? '' : 's'} waited; ${fate}.`);
    } catch {
      // A slept row that is not JSON was written by hand: the lid line is left out.
    }
  }

  const header = `${project.name} · ${dayWords(now)} · since ${dayTime(since)}`;
  return { text: layout(header, parts, tail), parts, yours: yoursN, decided: decidedN, held: heldN };
}

/** The newest 'morning' row of the project: its time, and its list text ('' for a day with nothing). */
export function lastMorning(ctx: Ctx, projectId: number): { at: string; text: string } | undefined {
  return ctx.db.prepare("SELECT at, text FROM lead_events WHERE project_id = ? AND kind = 'morning' ORDER BY at DESC, id DESC LIMIT 1").get(projectId) as { at: string; text: string } | undefined;
}

/**
 * What `lead morning` prints: today's written list (the last morning row's text) when one exists, then `Since then:` with
 * anything new since it; before today's list exists, the list built now from the last morning row (or the round's start),
 * or "Nothing since <time>.".
 */
export function readMorning(ctx: Ctx, projectId: number): string {
  const now = ctx.now();
  const last = lastMorning(ctx, projectId);
  const since = last?.at ?? roundFirstOn(ctx.db, projectId) ?? now;
  const fresh = morningList(ctx, projectId, since, now).text;
  if (last !== undefined && last.text !== '' && dateKey(last.at) === dateKey(now)) return fresh === '' ? last.text : `${last.text}\n\nSince then:\n${fresh}`;
  return fresh === '' ? `Nothing since ${dayTime(since)}.` : fresh;
}

/** The end of today's quiet hours as an ISO time: `now`'s local date at the `to` minute. */
export function quietEndToday(now: string, toMinutes: number): string {
  const d = new Date(now);
  d.setHours(Math.floor(toMinutes / 60), toMinutes % 60, 0, 0);
  return d.toISOString();
}

/**
 * The minute watch's morning part. For each project with the round on, once now is past today's quiet-hours end and no
 * 'morning' row has been written at or after that end or on today's date (quiet hours changed after the morning ran: still
 * one a day), the list since the last morning row (or the round's first switch-on) is built: one list for a missed night,
 * not two. A list with something in it is, in one write, a 'morning' row, a Voice line, and a start send for the day's lead
 * thread when the project has one set up; an empty day writes the 'morning' row with no text and sends nothing. One
 * project's failure is logged and never stops the others. Returns how many projects got a list.
 */
export function watchMorning(ctx: Ctx, log?: { error: (message: string) => void }): number {
  let made = 0;
  for (const projectId of liveProjectsWithRound(ctx.db)) {
    try {
      if (morningFor(ctx, projectId)) made++;
    } catch (err) {
      log?.error(`Could not write the morning list of project ${projectId}: ${(err as Error).message}`);
    }
  }
  return made;
}

/**
 * The id of the project's thread for the day of `now`: the result of the day's morning start send, once it is done. Read
 * from the send itself (its retry key names the day), so no second record of it can fall out of step.
 */
export function dayThreadOf(ctx: Ctx, projectId: number, now: string): string | undefined {
  const row = ctx.db.prepare("SELECT result FROM lead_sends WHERE retry_key = ? AND kind = 'start' AND state = 'done'").pluck().get(`morning-thread:${projectId}:${dateKey(now)}`) as string | null | undefined;
  return row === null || row === undefined || row === '' ? undefined : row;
}

/** The day's thread's title: `<Project> lead <Weekday d Month>`, local time. */
export const threadTitle = (projectName: string, now: string): string => `${projectName} lead ${dayWords(now)}`;

/** The day's thread's first message: the lead's opening, its rules by command, then this morning's list. */
export const threadOpening = (projectName: string, slug: string, lead: string, list: string): string =>
  `You are ${lead}, the lead for ${projectName}. Run: inprogress lead rules ${slug} --as ${lead} and follow them. Then read this morning's list:

${list}`;

/** Whether a morning row is written at or after `end`, or on the date of `now`. */
const writtenToday = (ctx: Ctx, projectId: number, end: string, now: string): boolean => {
  const last = lastMorning(ctx, projectId);
  return last !== undefined && (last.at >= end || dateKey(last.at) === dateKey(now));
};

function morningFor(ctx: Ctx, projectId: number): boolean {
  const now = ctx.now();
  const end = quietEndToday(now, quietHours(ctx.db, projectId).to);
  if (now < end || writtenToday(ctx, projectId, end, now)) return false;
  const project = getProjectById(ctx, projectId);
  const since = lastMorning(ctx, projectId)?.at ?? roundFirstOn(ctx.db, projectId);
  if (project === undefined || project.lead === null || since === null) return false;
  const lead = project.lead;
  // Built and written in one write, so two ticks at once never write two lists.
  return write(
    ctx,
    'system',
    () => {
      if (writtenToday(ctx, projectId, end, now)) return false;
      const list = morningList(ctx, projectId, since, now);
      insertLeadEvent(ctx.db, { projectId, lead, instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'morning', text: list.text }, now);
      if (list.text === '') return false;
      const date = dateKey(now);
      intendSend(
        ctx.db,
        {
          projectId,
          kind: 'voice_line',
          target: 'webhook',
          retryKey: `morning:${projectId}:${date}`,
          body: `${project.name} morning list: ${list.yours} yours, ${list.decided} decided, ${list.held} held. Say "the list" for all of it.`,
        },
        now,
      );
      const folder = ctx.home === undefined ? undefined : leadFolderOf(ctx.home, project.slug);
      if (folder !== undefined && leadThreadOn(ctx.db, projectId)) {
        const { provider, model } = startProviderModel();
        intendSend(
          ctx.db,
          { projectId, kind: 'start', target: folder, retryKey: `morning-thread:${projectId}:${date}`, body: JSON.stringify({ message: threadOpening(project.name, project.slug, lead, list.text), title: threadTitle(project.name, now), provider, model }) },
          now,
        );
      }
      return true;
    },
    { immediate: true },
  );
}

/** The longest the minute watch may go between ticks before the gap counts as the laptop sleeping. */
export const WAKE_GAP_MS = 3 * 60 * 1000;
const lastTick = new WeakMap<object, string>();

/** Whether the gap from `from` to `to` overlaps the quiet hours `q` (minutes of the local day) on any day it touches. */
export function overlapsQuiet(from: string, to: string, q: { from: number; to: number }): boolean {
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  const last = new Date(to);
  for (let d = new Date(day.getTime() - 24 * 3600 * 1000); d <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, q.from).getTime();
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (q.to > q.from ? 0 : 1), 0, q.to).getTime();
    if (start < Date.parse(to) && end > Date.parse(from)) return true;
  }
  return false;
}

/**
 * The minute watch's sleep part: when this tick finds the last one more than WAKE_GAP_MS ago, the laptop slept; a 'slept'
 * row (text JSON `{from, to}`) is written for each project with the round on whose quiet hours the gap overlaps (inside the night), for the morning list's lid line. Returns
 * whether a gap was seen.
 */
export function noteWake(ctx: Ctx): boolean {
  const now = ctx.now();
  const before = lastTick.get(ctx.db);
  lastTick.set(ctx.db, now);
  if (before === undefined || Date.parse(now) - Date.parse(before) <= WAKE_GAP_MS) return false;
  for (const projectId of liveProjectsWithRound(ctx.db)) {
    const lead = getProjectById(ctx, projectId)?.lead;
    if (lead === null || lead === undefined || !overlapsQuiet(before, now, quietHours(ctx.db, projectId))) continue;
    write(ctx, 'system', () => insertLeadEvent(ctx.db, { projectId, lead, instructions: LEAD_INSTRUCTIONS_VERSION, kind: 'slept', text: JSON.stringify({ from: before, to: now }) }, now));
  }
  return true;
}
