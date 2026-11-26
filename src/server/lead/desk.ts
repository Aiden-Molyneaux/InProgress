import { sessionActivity } from '../../core/activity';
import { STALE_SESSION_MS } from '../../core/types';
import { stamp } from '../../core/span';
import { write, type Ctx } from '../db/tx';
import { aidensAskSql } from '../repo/asks';
import { getDeskItem, openDeskItems, type DeskItem } from '../repo/desk';
import { DESK_ASK_DUE_MS, itemEverMade, plusMs, produceDeskItem } from '../repo/deskProducers';
import { resolveProject } from '../repo/projects';
import { findSession } from '../repo/sessions';
import { liveProjectsWithRound, roundBound } from '../repo/switches';
import { askStoppedInWrite, closeStoppedInWrite, stoppedRef } from './stopped';

export { DESK_ASK_DUE_MS, onDeskItem } from '../repo/deskProducers';

/** How long a worker session must have been stopped before the minute watch makes a `stopped` item. */
export const DESK_STOPPED_MS = 10 * 60 * 1000;
/** How long after the minute watch makes an item (stopped, promise_due, or a swept ask's) it is due. */
export const DESK_WATCH_DUE_MS = 5 * 60 * 1000;

/** What one minute's desk watch made, per pass. */
export interface DeskWatchResult {
  stopped: number;
  /** Stopped sessions asked where their work stands (relay sends the sender carries out after the commit). */
  asked: number;
  promiseDue: number;
  swept: number;
}

/**
 * The minute watch's desk part. For each active, live project whose round is on, three passes, each in its own write:
 * stopped (a worker session idle on an active step with no open ask of Aiden's, stopped DESK_STOPPED_MS to
 * STALE_SESSION_MS ago and not before the round was first switched on; an open stopped item whose session has moved on
 * since is closed first), promise_due (a lead's promise past its time), and the sweep (a session's question or permission
 * ask raised since the round was first switched on that has no desk item: one raised while the round was off, or while a
 * rolled-back build ran). Each cause makes one item, however often the watch runs.
 */
export function watchDesk(ctx: Ctx): DeskWatchResult {
  const result: DeskWatchResult = { stopped: 0, asked: 0, promiseDue: 0, swept: 0 };
  for (const projectId of liveProjectsWithRound(ctx.db)) {
    const stopped = write(ctx, 'system', () => stoppedPass(ctx, projectId));
    result.stopped += stopped.made;
    result.asked += stopped.asked;
    result.promiseDue += write(ctx, 'system', () => promiseDuePass(ctx, projectId));
    result.swept += write(ctx, 'system', () => sweepPass(ctx, projectId));
  }
  return result;
}

/**
 * The stopped pass: closes the items whose session moved on, makes the new ones, and asks each open one that can be asked
 * and was not (stopped.ts's askStoppedInWrite). A session asked on a step is never given another item on that step.
 */
function stoppedPass(ctx: Ctx, projectId: number): { made: number; asked: number } {
  const bound = roundBound(ctx.db, projectId);
  if (bound === null) return { made: 0, asked: 0 };
  const now = ctx.now();
  // A stop the session has moved on from (a prompt, a hook since) is no longer a stop: its open item closes, and an ask not
  // yet sent is cleared. The SQL reads stoppedRef's `<session id>@<last_seen_at>` with instr and substr.
  const movedOn = ctx.db
    .prepare(
      `SELECT d.id FROM desk_items d
       WHERE d.project_id = ? AND d.kind = 'stopped' AND d.state = 'open' AND instr(d.ref, '@') > 0
         AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = substr(d.ref, 1, instr(d.ref, '@') - 1)
                     AND s.last_seen_at > substr(d.ref, instr(d.ref, '@') + 1))`,
    )
    .pluck()
    .all(projectId) as number[];
  for (const id of movedOn) closeStoppedInWrite(ctx, id, 'session moved on');
  const nowMs = Date.parse(now);
  const latest = new Date(nowMs - DESK_STOPPED_MS).toISOString();
  const earliest = new Date(nowMs - STALE_SESSION_MS).toISOString();
  const candidates = ctx.db
    .prepare(
      `SELECT s.id, s.focus_node_id, s.last_seen_at FROM sessions s JOIN nodes n ON n.id = s.focus_node_id
       WHERE s.project_id = ? AND s.role = 'worker' AND s.state = 'idle' AND s.ended_at IS NULL AND n.status = 'active'
         AND s.last_seen_at <= ? AND s.last_seen_at >= ? AND s.last_seen_at >= ?
         AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.node_id = n.id AND a.cleared_at IS NULL AND ${aidensAskSql('a.')})
         AND NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.project_id = s.project_id AND e.kind = 'asked' AND e.session_id = s.id AND e.node_id = s.focus_node_id)
       ORDER BY s.last_seen_at, s.id`,
    )
    .all(projectId, latest, earliest, bound) as { id: string; focus_node_id: number; last_seen_at: string }[];
  let made = 0;
  for (const c of candidates) {
    const ref = stoppedRef(c.id, c.last_seen_at);
    if (itemEverMade(ctx.db, 'stopped', ref)) continue;
    const session = findSession(ctx, c.id);
    // Live background work (a subagent that is not a reader, a command that counts as work) is not a stop.
    if (session === undefined || sessionActivity(session, nowMs) !== 'idle') continue;
    if (produceDeskItem(ctx.db, { projectId, kind: 'stopped', ref, nodeId: c.focus_node_id, dueAt: plusMs(now, DESK_WATCH_DUE_MS) }, now).created) made++;
  }
  // The ask is plain code here, not in the runner's fill: a back-off or full lanes never delay it.
  let asked = 0;
  const open = ctx.db.prepare("SELECT id FROM desk_items WHERE project_id = ? AND kind = 'stopped' AND state = 'open' ORDER BY id").pluck().all(projectId) as number[];
  for (const id of open) {
    const item = getDeskItem(ctx.db, id);
    if (item !== undefined && askStoppedInWrite(ctx, item)) asked++;
  }
  return { made, asked };
}

function promiseDuePass(ctx: Ctx, projectId: number): number {
  const now = ctx.now();
  const due = ctx.db
    .prepare("SELECT id, node_id FROM asks WHERE project_id = ? AND owner = 'lead' AND cleared_at IS NULL AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at, id")
    .all(projectId, now) as { id: number; node_id: number }[];
  let made = 0;
  for (const a of due) {
    const ref = String(a.id);
    if (itemEverMade(ctx.db, 'promise_due', ref)) continue;
    if (produceDeskItem(ctx.db, { projectId, kind: 'promise_due', ref, nodeId: a.node_id, dueAt: plusMs(now, DESK_WATCH_DUE_MS) }, now).created) made++;
  }
  return made;
}

function sweepPass(ctx: Ctx, projectId: number): number {
  const bound = roundBound(ctx.db, projectId);
  if (bound === null) return 0;
  const now = ctx.now();
  const missing = ctx.db
    .prepare(
      `SELECT a.id, a.kind, a.node_id, a.raised_at FROM asks a
       WHERE a.project_id = ? AND ${aidensAskSql('a.')} AND a.kind IN ('question', 'permission') AND a.cleared_at IS NULL
         AND a.session_id IS NOT NULL AND a.raised_at >= ?
         AND NOT EXISTS (SELECT 1 FROM desk_items d WHERE d.kind = a.kind AND d.ref = CAST(a.id AS TEXT))
       ORDER BY a.raised_at, a.id`,
    )
    .all(projectId, bound) as { id: number; kind: 'question' | 'permission'; node_id: number; raised_at: string }[];
  let made = 0;
  for (const a of missing) {
    if (produceDeskItem(ctx.db, { projectId, kind: a.kind, ref: String(a.id), nodeId: a.node_id, dueAt: plusMs(a.raised_at, DESK_ASK_DUE_MS) }, now).created) made++;
  }
  return made;
}

/** One open item as `lead desk` prints it: `#<id> <kind> <ref> step #<node> due HH:MM (<n> min left|<n> min over) <state>`. */
function deskLine(item: DeskItem, nowMs: number): string {
  const step = item.nodeId === null ? 'no step' : `step #${item.nodeId}`;
  let due = 'no limit';
  if (item.dueAt !== null) {
    const diff = Date.parse(item.dueAt) - nowMs;
    const minutes = Math.round(Math.abs(diff) / 60_000);
    due = `due ${stamp(item.dueAt).slice(11)} (${minutes} min ${diff >= 0 ? 'left' : 'over'})`;
  }
  return `#${item.id} ${item.kind} ${item.ref} ${step} ${due} ${item.state}`;
}

/** The project's desk: its open items, oldest first, and the text `lead desk` prints. Local time, as the other lead text. */
export function readDesk(ctx: Ctx, ref: string): { items: DeskItem[]; text: string } {
  const project = resolveProject(ctx, ref);
  const items = openDeskItems(ctx.db, project.id);
  const nowMs = Date.parse(ctx.now());
  return { items, text: items.length === 0 ? 'The desk is empty.' : items.map((i) => deskLine(i, nowMs)).join('\n') };
}
