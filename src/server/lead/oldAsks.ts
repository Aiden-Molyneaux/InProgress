import { LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { askTag } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { badRequest, conflict } from '../errors';
import { outOfDate } from '../lead';
import { requireAnswerLead, requireLeadWho, workProject, WORK_PROJECT } from '../lead-commands';
import { aidensAskSql, requireAsk } from '../repo/asks';
import { addDeskItem } from '../repo/desk';
import { itemEverMade, produceDeskItem } from '../repo/deskProducers';
import { insertLeadEvent } from '../repo/leadEvents';
import { roundFirstOn, roundSince } from '../repo/switches';
import { dateKey } from './morning';
import { intendOldAskLine, intendOldAsksDoneLine, OLD_DONE_KEY_LIKE, OLD_KEY_LIKE, oldAskVoiceLine } from './voice';

/*
 * The old asks (lead stage 1, #743, task 17): Aiden's asks raised before the round was first switched on in their project.
 * `lead old-asks <project>` puts them on the desk as `old_ask` items, once each: open for the round in a project this lead
 * leads with its round on, else waiting on Aiden. `lead old-asks next` brings those waiting on him to the Voice, a few at a
 * time, oldest ask first; his answer comes back through `lead answer --send`, which clears the ask and so closes the item.
 */

/** The most old-ask lines that wait on Aiden at once, and the most one `next` queues. */
export const OLD_ASKS_AT_ONCE = 5;
/** The refusal of `next` while OLD_ASKS_AT_ONCE old-ask lines wait on his answer. */
export const OLD_ASKS_WITH_AIDEN = 'Five old asks are with Aiden already.';
/** What `next` answers when no old ask waits for a line. */
export const NO_OLD_ASKS = 'No old asks remain.';
/** The kind of the lead_events line that holds the lead's reading of an old ask. */
export const OLD_READING = 'old_reading';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `lead old-asks <project>`: every open ask of Aiden's in the project raised before the round's first switch-on there (every
 * open ask when the round has never been on) becomes an `old_ask` desk item about it, on its step, unless one was ever
 * made. In a project this lead leads with its round on the item is open, for the round's old lane; anywhere else it waits
 * on Aiden, for the Voice. The project is one this lead leads or one with no lead (requireAnswerLead); one under C:\work is
 * refused.
 */
export function leadOldAsks(ctx: Ctx, ref: string, as: string, instructions: number): { text: string; forRound: number; forVoice: number } {
  const { project, actor } = requireAnswerLead(ctx, ref, as, instructions);
  if (workProject(ctx, project.id)) throw conflict(WORK_PROJECT);
  return write(ctx, actor, () => {
    const { forRound, forVoice } = putOldAsks(ctx, { id: project.id, lead: project.lead });
    return { text: putLine(forRound, forVoice), forRound, forVoice };
  });
}

/** The sentence a put answers: how many old asks went on the desk, and where. */
const putLine = (k: number, m: number): string => `Put ${k + m} old asks on the desk: ${k} for the round, ${m} for the Voice.`;

/**
 * Inside the caller's write: the project's old asks onto the desk, each once. A project with a lead (it is this lead's: the
 * caller checked) and its round on takes them open, for the round; any other waits on Aiden. Answers how many of each.
 */
function putOldAsks(ctx: Ctx, project: { id: number; lead: string | null }): { forRound: number; forVoice: number } {
  const db = ctx.db;
  const now = ctx.now();
  const first = roundFirstOn(db, project.id);
  const asks = db
    .prepare(`SELECT id, node_id AS nodeId FROM asks WHERE project_id = ? AND cleared_at IS NULL AND ${aidensAskSql()}${first === null ? '' : ' AND raised_at < ?'} ORDER BY raised_at, id`)
    .all(...(first === null ? [project.id] : [project.id, first])) as { id: number; nodeId: number }[];
  const led = project.lead !== null && project.lead.trim() !== '';
  const forRound = led && roundSince(db, project.id) !== null;
  let made = 0;
  for (const ask of asks) {
    const refText = String(ask.id);
    if (itemEverMade(db, 'old_ask', refText)) continue;
    const input = { projectId: project.id, kind: 'old_ask' as const, ref: refText, nodeId: ask.nodeId };
    // An open item wakes the runner; one waiting on Aiden has no one to wake.
    const { created } = forRound ? produceDeskItem(db, input, now) : addDeskItem(db, { ...input, state: 'waiting_aiden' }, now);
    if (created) made++;
  }
  return { forRound: forRound ? made : 0, forVoice: forRound ? 0 : made };
}

/**
 * The lead of the commands that name no project (`next`, `--all`): a name that is not a lead's is a 400, one that leads no
 * project (active or paused, not deleted) a 409, and older rules a 409 naming the first project it leads.
 */
function requireLeadName(ctx: Ctx, as: string, instructions: number): string {
  const name = as.trim();
  requireLeadWho(name, instructions, '', true, false);
  const slug = ctx.db
    .prepare("SELECT slug FROM projects WHERE status <> 'archived' AND deleted_at IS NULL AND lead IS NOT NULL AND lower(trim(lead)) = lower(?) ORDER BY id LIMIT 1")
    .pluck()
    .get(name) as string | undefined;
  if (slug === undefined) throw conflict(leadsNoProject(name));
  requireLeadWho(name, instructions, slug, false);
  return name;
}

/** The refusal of `next` or `--all` for a name that leads no project. */
export const leadsNoProject = (name: string): string => `${name} leads no project.`;

/**
 * Aiden's personal projects this lead may carry his answers in, by id: not archived or deleted, not under C:\work, and
 * with no lead or this one. Inside the caller's write.
 */
function personalProjects(ctx: Ctx, name: string): { id: number; name: string; lead: string | null }[] {
  return (ctx.db
    .prepare("SELECT id, name, lead FROM projects WHERE status <> 'archived' AND deleted_at IS NULL ORDER BY id")
    .all() as { id: number; name: string; lead: string | null }[]).filter(
    (p) => (p.lead === null || p.lead.trim() === '' || p.lead.trim().toLowerCase() === name.toLowerCase()) && !workProject(ctx, p.id),
  );
}

/**
 * `lead old-asks --all`: `lead old-asks <project>` for every personal project `next` serves (personalProjects), in one
 * write. Answers one line for each project that had an old ask put on the desk, then the total.
 */
export function leadOldAsksAll(ctx: Ctx, as: string, instructions: number): { text: string; forRound: number; forVoice: number } {
  const name = requireLeadName(ctx, as, instructions);
  return write(ctx, `lead:${name}`, () => {
    const lines: string[] = [];
    let k = 0;
    let m = 0;
    for (const project of personalProjects(ctx, name)) {
      const put = putOldAsks(ctx, project);
      if (put.forRound + put.forVoice === 0) continue;
      lines.push(`${project.name}: ${put.forRound + put.forVoice} old asks, ${put.forRound} for the round, ${put.forVoice} for the Voice.`);
      k += put.forRound;
      m += put.forVoice;
    }
    return { text: [...lines, putLine(k, m)].join('\n'), forRound: k, forVoice: m };
  });
}

/** SQL: an old ask's line (not the done line), as `s`. */
const OLD_LINE_SQL = `s.kind = 'voice_line' AND s.retry_key LIKE '${OLD_KEY_LIKE}' AND s.retry_key NOT LIKE '${OLD_DONE_KEY_LIKE}'`;
/** SQL: a line still with Aiden or on its way: intended (or being tried), or done. One that ended unknown or cleared is not. */
const LIVE_LINE_SQL = `s.state IN ('intended', 'done')`;
/** How long a line he heard waits for his answer before it stops counting against the cap: its ask stays his, in the window. */
export const OLD_LINE_HEARD_MS = 24 * 60 * 60 * 1000;
/** How many lines an old ask gets: its first, and one more after a line that ended unknown or cleared. */
export const OLD_LINES_PER_ASK = 2;

/**
 * `lead old-asks next [count]`: queues one Voice line for each of the next `count` old_ask items (at most OLD_ASKS_AT_ONCE
 * less the old-ask lines already waiting on his answer) that wait on Aiden with no live line, oldest ask first, across his
 * personal projects (personalProjects: the projects `lead answer` can carry his reply in). A line waits on his answer while
 * it is intended or done and its item is not done; one that ended unknown (a refused webhook) or cleared does not, and its
 * item is queued again under the next key (oldLineKey). Only items of those projects count. Refused while OLD_ASKS_AT_ONCE
 * lines wait. With none to queue it answers NO_OLD_ASKS, and once no line waits either, queues the line that says they
 * are done, once a day, in the project of the newest old-ask line.
 */
export function leadOldAsksNext(ctx: Ctx, as: string, instructions: number, count = OLD_ASKS_AT_ONCE): { text: string; queued: number; remain: number } {
  const name = requireLeadName(ctx, as, instructions);
  if (!Number.isInteger(count) || count < 1 || count > OLD_ASKS_AT_ONCE) throw badRequest(`The count is a whole number from 1 to ${OLD_ASKS_AT_ONCE}, not ${count}.`);
  return write(ctx, `lead:${name}`, () => {
    const db = ctx.db;
    const now = ctx.now();
    const projects = personalProjects(ctx, name);
    const byId = new Map(projects.map((p) => [p.id, p]));
    const served = (projectId: number): boolean => byId.has(projectId);
    const pending = (db
      .prepare(
        `SELECT d.project_id FROM lead_sends s JOIN desk_items d ON d.id = s.item_id
          WHERE ${OLD_LINE_SQL} AND ${LIVE_LINE_SQL} AND d.state <> 'done' AND NOT (s.state = 'done' AND s.done_at <= ?)`,
      )
      .pluck()
      .all(new Date(Date.parse(now) - OLD_LINE_HEARD_MS).toISOString()) as number[]).filter(served).length;
    if (pending >= OLD_ASKS_AT_ONCE) throw conflict(OLD_ASKS_WITH_AIDEN);
    const waiting = (db
      .prepare(
        `SELECT d.id, d.project_id AS projectId, a.id AS askId, a.node_id AS nodeId, a.raised_at AS raisedAt,
                (SELECT COUNT(*) FROM lead_sends s WHERE s.item_id = d.id AND ${OLD_LINE_SQL}) AS lines
           FROM desk_items d JOIN asks a ON a.id = CAST(d.ref AS INTEGER)
          WHERE d.kind = 'old_ask' AND d.state = 'waiting_aiden'
            AND NOT EXISTS (SELECT 1 FROM lead_sends s WHERE s.item_id = d.id AND ${OLD_LINE_SQL} AND ${LIVE_LINE_SQL})
          ORDER BY a.raised_at, a.id, d.id`,
      )
      .all() as { id: number; projectId: number; askId: number; nodeId: number; raisedAt: string; lines: number }[])
      // After its second line ends unknown or cleared, an old ask stays his in the window: no third line.
      .filter((r) => served(r.projectId) && r.lines < OLD_LINES_PER_ASK);
    if (waiting.length === 0) {
      if (pending === 0) {
        const last = (db.prepare(`SELECT s.project_id FROM lead_sends s WHERE ${OLD_LINE_SQL} ORDER BY s.id DESC`).pluck().all() as number[]).find(served);
        if (last !== undefined) intendOldAsksDoneLine(db, { projectId: last, date: dateKey(now) }, now);
      }
      return { text: NO_OLD_ASKS, queued: 0, remain: 0 };
    }
    // With the lines already waiting on him, never more than OLD_ASKS_AT_ONCE with him at once.
    const take = waiting.slice(0, Math.min(count, OLD_ASKS_AT_ONCE - pending));
    /**
     * Each project's old asks, done ones too, so "i of total" holds from one batch to the next: counted by the item, in the
     * order they were put on the desk (each put takes them oldest ask first), whether or not its ask is still there.
     */
    const order = new Map<number, number[]>();
    const orderOf = (projectId: number): number[] => {
      let ids = order.get(projectId);
      if (ids === undefined) {
        ids = db.prepare("SELECT id FROM desk_items WHERE kind = 'old_ask' AND project_id = ? ORDER BY created_at, id").pluck().all(projectId) as number[];
        order.set(projectId, ids);
      }
      return ids;
    };
    for (const row of take) {
      const ids = orderOf(row.projectId);
      const title = db.prepare('SELECT title FROM nodes WHERE id = ?').pluck().get(row.nodeId) as string | undefined;
      const body = oldAskVoiceLine({
        projectName: byId.get(row.projectId)!.name,
        index: ids.indexOf(row.id) + 1,
        total: ids.length,
        stepId: row.nodeId,
        stepTitle: title ?? null,
        days: Math.max(0, Math.floor((Date.parse(now) - Date.parse(row.raisedAt)) / DAY_MS)),
        reading: oldReading(ctx, row.askId),
      });
      intendOldAskLine(db, { projectId: row.projectId, itemId: row.id, body, n: row.lines + 1 }, now);
    }
    const remain = waiting.length - take.length;
    return { text: `Queued ${take.length} old asks for the Voice; ${remain} remain.`, queued: take.length, remain };
  });
}

/** Writes an `old_reading` line for the ask, inside the caller's write: the latest one is its reading. Answers its id. */
export function storeOldReadingInWrite(ctx: Ctx, input: { projectId: number; lead: string; askId: number; nodeId: number; reading: string }): number {
  return insertLeadEvent(
    ctx.db,
    { projectId: input.projectId, lead: input.lead, instructions: LEAD_INSTRUCTIONS_VERSION, kind: OLD_READING, askId: input.askId, nodeId: input.nodeId, text: readingText(input.askId, input.reading.trim()) },
    ctx.now(),
  );
}

/** The text an `old_reading` line holds: the ask, then the reading. */
const readingText = (askId: number, reading: string): string => `${askTag(askId)}: ${reading}`;

/** The lead's latest reading of the ask, or null when none is stored. */
export function oldReading(ctx: Ctx, askId: number): string | null {
  const text = ctx.db.prepare(`SELECT text FROM lead_events WHERE kind = '${OLD_READING}' AND ask_id = ? ORDER BY id DESC LIMIT 1`).pluck().get(askId) as string | undefined;
  if (text === undefined) return null;
  const prefix = `${askTag(askId)}: `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/**
 * `lead old-asks reading <project> <ask> <text>`: stores the lead's reading of an old ask, shown in its Voice line, as an
 * `old_reading` line in the lead's log (the ask in its text and its ask column). The latest reading of an ask wins. The
 * project is one `lead answer` may write to; one under C:\work is refused.
 */
export function leadOldAskReading(ctx: Ctx, ref: string, as: string, instructions: number, input: { askId: number; text: string }): { text: string; eventId: number } {
  const { project, name, actor } = requireAnswerLead(ctx, ref, as, instructions);
  if (workProject(ctx, project.id)) throw conflict(WORK_PROJECT);
  return write(ctx, actor, () => {
    const ask = requireAsk(ctx, input.askId);
    if (ask.projectId !== project.id) throw conflict(`${askTag(ask.id)} is not in this project.`);
    const eventId = storeOldReadingInWrite(ctx, { projectId: project.id, lead: name, askId: ask.id, nodeId: ask.nodeId, reading: input.text });
    return { text: `Stored your reading of ${askTag(ask.id)}.`, eventId };
  });
}
