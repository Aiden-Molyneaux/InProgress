import { LEAD_INSTRUCTIONS_VERSION } from '../core/lead';
import { spanAgo, stamp } from '../core/span';
import type { Ask } from '../core/types';
import { conflict, notFound } from './errors';
import { requireLead } from './lead';
import { clean, line } from './lead-text';
import type { Ctx } from './db/tx';
import { listNodeAsks } from './repo/asks';
import { listLogs } from './repo/logs';
import { findNode, requireNode } from './repo/nodes';
import { listNodeResources, requireResource } from './repo/resources';
import { countStepSessions, listStepSessions } from './repo/sessions';
import { listWorkItems } from './repo/work';

/** The most log lines `lead step` prints, newest first. */
export const LEAD_STEP_LOG_CAP = 60;
/** How much of a step's notes, or of one ask's text or answer, `lead step` keeps. */
export const LEAD_STEP_TEXT_CUT = 4_000;
/** How much of a stored document `lead resource` prints. */
export const LEAD_RESOURCE_CUT = 120_000;
/** The most cleared asks `lead step` prints: the newest ones; every open ask is printed. */
export const LEAD_STEP_ASK_CAP = 20;
/** The most steps under a step `lead step` prints. */
export const LEAD_STEP_CHILD_CAP = 40;
/** How much of one log line `lead step` keeps. */
const LOG_LINE_CUT = 1_000;
/** The most open working tasks `lead step` names. */
const TASK_CAP = 10;

/** Text on one line, in full up to `max` characters; beyond that it ends with how much was cut. */
function cutText(text: string, max: number): string {
  const one = clean(text).trim();
  return one.length <= max ? one : `${one.slice(0, max)} (cut: ${one.length - max} more characters)`;
}

const notInProject = (prefix: string, id: number): never => {
  throw conflict(`${prefix}${id} is not in this project.`);
};

function askLine(a: Ask, now: number): string {
  const tag = `a${a.id} ${a.owner === 'lead' ? 'promise' : a.kind}`;
  const text = `"${cutText(a.text, LEAD_STEP_TEXT_CUT)}"`;
  if (a.clearedAt === null) return `${tag} · open, raised ${spanAgo(a.raisedAt, now)} ago: ${text}`;
  if (a.answer.trim()) return `${tag} · answered ${spanAgo(a.clearedAt, now)} ago: ${text} -> "${cutText(a.answer, LEAD_STEP_TEXT_CUT)}"`;
  return `${tag} · cleared ${spanAgo(a.clearedAt, now)} ago with no answer: ${text}`;
}

/** Everything on record about one step of the lead's project, as text. A read: it changes nothing. */
export function readLeadStep(ctx: Ctx, ref: string, as: string, instructions: number, stepId: number, now: Date): { text: string } {
  const project = requireLead(ctx, ref, as, instructions, false);
  const node = findNode(ctx, stepId);
  if (!node) throw notFound(`#${stepId} not found.`, `Run "outline ${project.slug}" to see this project's steps.`);
  if (node.projectId !== project.id) notInProject('#', stepId);
  const nowMs = now.getTime();
  const out: string[] = [];

  out.push(`#${node.id} ${clean(node.title)} · ${node.status}${node.label === null ? '' : ` · ${node.label}`} · origin ${node.origin}`);
  if (node.parentId !== null) {
    const parent = ctx.db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(node.parentId) as { id: number; title: string } | undefined;
    if (parent) out.push(`Under: #${parent.id} ${clean(parent.title)}`);
  }
  out.push(`Changed ${spanAgo(node.updatedAt, nowMs)} ago · created ${stamp(node.createdAt)}${node.completedAt === null ? '' : ` · done ${stamp(node.completedAt)}`}`);
  // What, Why and Outcome are written for Aiden and short: whole. Notes can be long: cut.
  for (const [label, text, max] of [['What', node.what, Infinity], ['Why', node.why, Infinity], ['Outcome', node.outcome, Infinity], ['Notes', node.body, LEAD_STEP_TEXT_CUT]] as const) {
    if (text.trim()) out.push(`${label}: ${cutText(text, max)}`);
  }

  const sessions = listStepSessions(ctx, node.id);
  if (sessions.length) {
    const all = countStepSessions(ctx, node.id);
    out.push(`Sessions (${all > sessions.length ? `${sessions.length} of ${all}` : sessions.length}):`);
    for (const s of sessions) {
      const title = line(s.title ?? '', 80) || `Session ${s.id.slice(0, 6)}`;
      const when = s.endedAt !== null ? `ended ${spanAgo(s.endedAt, nowMs)} ago` : `${s.state}, seen ${spanAgo(s.lastSeenAt, nowMs)} ago`;
      out.push(`  "${title}" · ${s.app}${s.t3ThreadId ? ` · thread ${clean(s.t3ThreadId)}` : ''} · ${when}`);
    }
  }

  const asks = listNodeAsks(ctx, node.id);
  if (asks.length) {
    // Every open ask, then the newest cleared ones, each group oldest first.
    const cleared = asks.filter((a) => a.clearedAt !== null);
    const kept = cleared.slice(Math.max(0, cleared.length - LEAD_STEP_ASK_CAP));
    const shown = [...asks.filter((a) => a.clearedAt === null), ...kept];
    out.push(`Asks (${asks.length}):`, ...shown.map((a) => `  ${askLine(a, nowMs)}`));
    if (cleared.length > kept.length) out.push(`  and ${cleared.length - kept.length} more, cleared earlier`);
  }

  const work = listWorkItems(ctx, project.id).filter((w) => w.nodeId === node.id);
  if (work.length) {
    const open = work.filter((w) => w.status !== 'completed');
    out.push(`Working tasks (${work.length - open.length} done, ${open.length} open):`, ...open.slice(0, TASK_CAP).map((w) => `  open: ${line(w.subject, 200)}`));
    if (open.length > TASK_CAP) out.push(`  and ${open.length - TASK_CAP} more`);
  }

  const documents = listNodeResources(ctx, node.id);
  if (documents.length) {
    out.push(`Documents (${documents.length}):`);
    for (const r of documents) {
      const where: string[] = [];
      if (r.path) where.push(`file ${clean(r.path)}`);
      if (r.contentLength > 0) where.push(`stored in InProgress, ${r.contentLength} characters: lead resource ${project.slug} ${r.id} --as ${project.lead!.trim()} --instructions ${LEAD_INSTRUCTIONS_VERSION}`);
      if (r.url) where.push(`link ${clean(r.url)}`);
      if (!where.length) where.push('nothing stored');
      out.push(`  r${r.id} ${r.purpose ?? r.kind} "${line(r.title, 120)}" · ${where.join(' · ')}`);
    }
  }

  const children = ctx.db.prepare('SELECT id, title, status FROM nodes WHERE parent_id = ? ORDER BY position, id').all(node.id) as { id: number; title: string; status: string }[];
  if (children.length) out.push(`Steps under it (${children.length}):`, ...children.slice(0, LEAD_STEP_CHILD_CAP).map((c) => `  #${c.id} ${line(c.title, 120)} · ${c.status}`));
  if (children.length > LEAD_STEP_CHILD_CAP) out.push(`  and ${children.length - LEAD_STEP_CHILD_CAP} more`);

  const total = ctx.db.prepare('SELECT COUNT(*) FROM log_entries WHERE node_id = ?').pluck().get(node.id) as number;
  if (total > 0) {
    // listLogs answers oldest first; the step prints newest first.
    const logs = listLogs(ctx, node.id, LEAD_STEP_LOG_CAP).reverse();
    out.push(`Log, newest first (${logs.length} of ${total}):`, ...logs.map((l) => `  ${stamp(l.createdAt)} · ${line(l.text, LOG_LINE_CUT)}`));
  }
  return { text: out.join('\n') };
}

/** One document of the lead's project: its stored content, or where to read it. A read: it changes nothing. */
export function readLeadResource(ctx: Ctx, ref: string, as: string, instructions: number, resourceId: number): { text: string } {
  const project = requireLead(ctx, ref, as, instructions, false);
  let r;
  try {
    r = requireResource(ctx, resourceId);
  } catch (err) {
    // requireResource's hint names an MCP tool the lead has no use for; only its not-found is reworded.
    if ((err as { status?: number }).status === 404) throw notFound(`r${resourceId} not found.`, "lead step lists a step's documents.");
    throw err;
  }
  if (r.projectId !== project.id) notInProject('r', resourceId);
  const node = requireNode(ctx, r.nodeId);
  const head = `r${r.id} ${r.purpose ?? r.kind} "${line(r.title, 120)}" on #${node.id} ${clean(node.title)}`;
  const content = r.content ?? '';
  let body: string;
  if (content.length > 0) body = content.length > LEAD_RESOURCE_CUT ? `${content.slice(0, LEAD_RESOURCE_CUT)}\n(cut: ${content.length - LEAD_RESOURCE_CUT} more characters)` : content;
  else if (r.path) body = `Not stored in InProgress. Read the file: ${clean(r.path)}`;
  else if (r.url) body = `A link: ${clean(r.url)}`;
  else body = `r${r.id} has nothing stored.`;
  return { text: `${head}\n\n${body}` };
}
