import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CHECKED_ACTIONS, gitFolderOption, heldActions, mergeTarget, playbookHeldLines, pushTarget, type HeldActionName, type HeldMatch } from '../../core/hold';
import { LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import { clipLine } from '../../core/step-ref';
import { heldFile } from '../../hooks/hold';
import type { Ctx } from '../db/tx';
import { getDeskItem, moveDeskItem } from '../repo/desk';
import { DESK_ASK_DUE_MS, plusMs, produceDeskItem } from '../repo/deskProducers';
import { insertLeadEvent } from '../repo/leadEvents';
import { findNode } from '../repo/nodes';
import type { Project } from '../../core/types';
import { getProjectById, resolveBinding } from '../repo/projects';
import { findSession } from '../repo/sessions';
import { isLiveWithRound } from '../repo/switches';
import { checkLanding, ghVisibility, realGit, type LandingDeps } from './landing';

/** What the hold and stuck routes answer when the lead has nothing to say: the hook prints nothing. */
export const SAY_NOTHING = { say: 'nothing' } as const;
export type SayNothing = typeof SAY_NOTHING;

/** How long the stuck route waits for the lead's verdict, and how often it looks. The hook waits 175 s, its timeout is 180 s. */
export const STUCK_WAIT_MS = 170_000;
export const STUCK_POLL_MS = 1000;
/** How much of a tool's input the stuck item's log line keeps. */
const STUCK_INPUT_MAX = 4000;
/** How much of a tool's input a permission decision's line keeps. */
const DECISION_INPUT_CUT = 80;

const REAL_DEPS: LandingDeps = { git: realGit, visibility: ghVisibility };

/** The session's project and its focus step, when the project has a lead and its round is on; else undefined. */
export interface LeadScope {
  project: Project;
  lead: string;
  sessionId: string | null;
  /** The session's focus step, when it is a step of this project. */
  stepId: number | null;
}

/**
 * The project a hook's call belongs to: the session's, else the one the folder is bound to. Undefined (the lead says
 * nothing) when there is none, it has no lead, or its round is off or it is not active.
 */
export function leadScopeOf(ctx: Ctx, sessionId: string | null | undefined, cwd: string): LeadScope | undefined {
  const session = sessionId ? findSession(ctx, sessionId) : undefined;
  const project = session?.projectId != null ? getProjectById(ctx, session.projectId) : cwd ? resolveBinding(ctx, cwd, session?.branch ?? null) : undefined;
  if (project === undefined || project.lead === null || project.lead.trim() === '') return undefined;
  if (!isLiveWithRound(ctx.db, project.id)) return undefined;
  const focus = session?.focusNodeId ?? null;
  const stepId = focus !== null && findNode(ctx, focus)?.projectId === project.id ? focus : null;
  return { project, lead: project.lead, sessionId: sessionId || null, stepId };
}

/** The desk item's ref for a held command: the same command retried by the same session is one item while it is not done. */
export const heldRef = (sessionId: string | null, command: string): string => createHash('sha1').update(`${sessionId ?? ''}\n${command}`).digest('hex');

/** The desk item's ref for a stuck permission request: its session, tool and input. */
export const stuckRef = (sessionId: string | null, toolName: string, toolInput: unknown): string =>
  createHash('sha1').update(`${sessionId ?? ''}\n${toolName}\n${JSON.stringify(toolInput ?? null)}`).digest('hex');

export interface HoldAsk {
  sessionId?: string | null;
  cwd: string;
  command: string;
  action: HeldActionName;
}

export type HoldAnswer = SayNothing | { held: true; text: string };

/** The checkout's branch, or null when it is on none or git could not tell. */
async function currentBranch(deps: LandingDeps, folder: string): Promise<string | null> {
  try {
    const r = await deps.git(folder, ['symbolic-ref', '-q', '--short', 'HEAD']);
    return r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  } catch {
    // git did not finish: the caller holds what it cannot read.
    return null;
  }
}

/** A held answer, as the route works it out: what the command does, and why it is held (for the log). */
type Judged = { clear: true } | { clear: false; what: string; why: string };

/** Runs the landing check for a held command, read from its words; any refusal of the check holds it. */
async function judge(ctx: Ctx, scope: LeadScope, ask: HoldAsk, match: HeldMatch, deps: LandingDeps): Promise<Judged> {
  if (!CHECKED_ACTIONS.includes(match.action)) return { clear: false, what: `${match.what} (${clipLine(match.segment, 120)})`, why: "this is Aiden's without a check" };
  let branch: string | undefined;
  let what = match.what;
  // `git -C <dir>` runs in that folder, not the session's: the check reads git there.
  const named = match.action === 'merge' || match.action === 'push' ? gitFolderOption(match.segment) : undefined;
  const folder = named === undefined ? ask.cwd : isAbsolute(named) ? named : resolve(ask.cwd, named);
  if (match.action === 'merge') {
    // Only a merge into main is on the list: a merge in a checkout on another branch goes into that branch.
    const on = await currentBranch(deps, folder);
    if (on !== null && on !== 'main') return { clear: true };
    if (on === null) return { clear: false, what: 'a merge', why: 'could not tell which branch this checkout is on' };
    const target = mergeTarget(match.segment);
    if (target === undefined) return { clear: false, what: 'a merge into main', why: 'could not tell what is being merged' };
    branch = target;
    what = `a merge of ${target} into main`;
  } else if (match.action === 'push') {
    const target = pushTarget(match.segment);
    if (!target.ok) return { clear: false, what: match.what, why: target.why };
    if (target.remote !== 'origin') return { clear: false, what: `a push to ${target.remote}`, why: `could not tell where ${target.remote} is: the check reads origin` };
    branch = target.branch;
    const pushed = branch ?? (await currentBranch(deps, folder));
    what = pushed === null ? 'a push to origin' : `a push of ${pushed} to origin`;
  } else if (match.action === 'deploy') {
    what = 'a deploy of main to the live build';
  } else if (match.action === 'publish') {
    const on = await currentBranch(deps, folder);
    what = on === null ? match.what : `a publish of ${on}`;
  }
  if (scope.stepId === null) return { clear: false, what, why: 'could not tell which step this is for' };
  try {
    const answer = await checkLanding(
      ctx,
      { ref: scope.project.slug, stepId: scope.stepId, action: match.action as 'merge' | 'deploy' | 'push' | 'publish', folder, ...(branch === undefined ? {} : { branch }) },
      deps,
    );
    return answer.clear ? { clear: true } : { clear: false, what, why: answer.text };
  } catch (err) {
    // A check that refuses (a 4xx: no such branch, a range it cannot read) or fails holds the command.
    return { clear: false, what, why: `the landing check could not answer: ${(err as Error).message}` };
  }
}

/**
 * POST /api/lead/hold: a command on the hold list, from the hold or permission hook. Says nothing when the session's
 * project has no lead or its round is off, or the command is not on this project's list; else names the action and runs
 * the landing check for a merge, deploy, push or publish (the rest are Aiden's without one). Clear: nothing. Held: a `held`
 * desk item waiting on Aiden (one per session and command while it is not done) and a `held` line in the lead's log, and
 * what the command does, in plain words.
 */
export async function holdCheck(ctx: Ctx, ask: HoldAsk, deps: LandingDeps = REAL_DEPS): Promise<HoldAnswer> {
  const scope = leadScopeOf(ctx, ask.sessionId, ask.cwd);
  if (scope === undefined) return SAY_NOTHING;
  const match = heldActions(ask.command, playbookHeldLines(scope.project.playbook)).find((m) => m.action === ask.action);
  if (match === undefined) return SAY_NOTHING;
  const judged = await judge(ctx, scope, ask, match, deps);
  if (judged.clear) return SAY_NOTHING;
  const now = ctx.now();
  ctx.db
    .transaction(() => {
      const { item, created } = produceDeskItem(ctx.db, { projectId: scope.project.id, kind: 'held', ref: heldRef(scope.sessionId, ask.command), nodeId: scope.stepId }, now);
      if (!created) return;
      // Aiden's by the check: the runner never leases it; the Voice and the morning list bring it.
      moveDeskItem(ctx.db, item.id, ['open'], 'waiting_aiden', { outcome: `held: ${judged.why}`, now });
      insertLeadEvent(
        ctx.db,
        {
          projectId: scope.project.id,
          lead: scope.lead,
          instructions: LEAD_INSTRUCTIONS_VERSION,
          kind: 'held',
          ...(scope.stepId === null ? {} : { nodeId: scope.stepId }),
          ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
          text: `${ask.command} -> ${judged.why}`,
        },
        now,
      );
    })
    .immediate();
  return { held: true, text: judged.what };
}

export interface StuckAsk {
  sessionId?: string | null;
  cwd: string;
  toolName: string;
  toolInput?: unknown;
}

export type StuckAnswer = SayNothing | { behavior: 'allow' | 'deny'; message: string };

/** What a stuck item's log line holds: the tool and its input, after the item's ref so the item finds it. */
const stuckLine = (ref: string, toolName: string, input: string): string => `${ref} ${toolName} ${input}`;

/** The tool and input of a stuck item, from its `stuck` line in the lead's log; undefined when the line is gone. */
export function stuckRequestOf(ctx: Ctx, item: { projectId: number; ref: string }): { toolName: string; input: string; sessionId: string | null } | undefined {
  const row = ctx.db
    .prepare("SELECT text, session_id FROM lead_events WHERE project_id = ? AND kind = 'stuck' AND substr(text, 1, ?) = ? ORDER BY id DESC LIMIT 1")
    .get(item.projectId, item.ref.length + 1, `${item.ref} `) as { text: string; session_id: string | null } | undefined;
  if (row === undefined) return undefined;
  const rest = row.text.slice(item.ref.length + 1);
  const space = rest.indexOf(' ');
  return space < 0 ? { toolName: rest, input: '', sessionId: row.session_id } : { toolName: rest.slice(0, space), input: rest.slice(space + 1), sessionId: row.session_id };
}

/** A tool's input as one line of the log: its JSON, clipped. */
export const inputText = (toolInput: unknown, max = STUCK_INPUT_MAX): string => clipLine(JSON.stringify(toolInput ?? null), max);

/** A permission decision's line: `<tool> <input clipped to 80> -> allow|deny`. */
export const permissionLine = (toolName: string, input: string, behavior: 'allow' | 'deny'): string => `${toolName} ${clipLine(input, DECISION_INPUT_CUT)} -> ${behavior}`;

/** What the lead's verdict on a stuck item says, read from its outcome: allow or deny with the reason, else undefined. */
export function stuckVerdict(outcome: string | null): { behavior: 'allow' | 'deny'; message: string } | undefined {
  const m = /^(ALLOW|DENY)(?: (.*))?$/s.exec(outcome ?? '');
  if (!m) return undefined;
  return { behavior: m[1] === 'ALLOW' ? 'allow' : 'deny', message: (m[2] ?? '').trim() };
}

export interface StuckWaitOptions {
  waitMs?: number;
  pollMs?: number;
  /** Resolves after `ms`; a timer unless a test gives another. */
  sleep?: (ms: number) => Promise<void>;
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST /api/lead/stuck: a permission request no hold covers, from the permission hook. Says nothing at once when the
 * project has no lead or its round is off. Else a `stuck` item (one per session, tool and input while it is not done),
 * due in 3 minutes, wakes the runner, and the request waits, reading the item every second for up to 170 seconds. A
 * DECIDE the lead applied answers allow or deny with his reason; anything else (AIDEN, CARD, an unclear answer, no verdict
 * in time) says nothing, so the prompt shows as it does today, and the item stays.
 */
export async function stuckWait(ctx: Ctx, ask: StuckAsk, opts: StuckWaitOptions = {}): Promise<StuckAnswer> {
  const scope = leadScopeOf(ctx, ask.sessionId, ask.cwd);
  if (scope === undefined) return SAY_NOTHING;
  const ref = stuckRef(scope.sessionId, ask.toolName, ask.toolInput);
  const now = ctx.now();
  const itemId = ctx.db
    .transaction(() => {
      const { item, created } = produceDeskItem(ctx.db, { projectId: scope.project.id, kind: 'stuck', ref, nodeId: scope.stepId, dueAt: plusMs(now, DESK_ASK_DUE_MS) }, now);
      if (created) {
        insertLeadEvent(
          ctx.db,
          {
            projectId: scope.project.id,
            lead: scope.lead,
            instructions: LEAD_INSTRUCTIONS_VERSION,
            kind: 'stuck',
            ...(scope.stepId === null ? {} : { nodeId: scope.stepId }),
            ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
            text: stuckLine(ref, ask.toolName, inputText(ask.toolInput)),
          },
          now,
        );
      }
      return item.id;
    })
    .immediate();
  const waitMs = opts.waitMs ?? STUCK_WAIT_MS;
  const pollMs = opts.pollMs ?? STUCK_POLL_MS;
  const sleep = opts.sleep ?? sleepFor;
  for (let waited = 0; ; waited += pollMs) {
    const item = getDeskItem(ctx.db, itemId);
    if (item === undefined || item.state === 'waiting_aiden') return SAY_NOTHING;
    if (item.state === 'done') return stuckVerdict(item.outcome) ?? SAY_NOTHING;
    if (waited >= waitMs) return SAY_NOTHING;
    await sleep(pollMs);
  }
}

/** The Held lines of every live project with a lead, merged: what the hold hook adds to P3's list. */
export function allHeldLines(ctx: Ctx): string[] {
  const rows = ctx.db.prepare("SELECT playbook FROM projects WHERE lead IS NOT NULL AND trim(lead) <> '' AND deleted_at IS NULL ORDER BY id").pluck().all() as string[];
  return [...new Set(rows.flatMap((p) => playbookHeldLines(p)))];
}

/** Writes `<home>/lead/held.json` from the playbooks' Held lines: a temporary file renamed over it, so the hook never reads half of one. */
export function writeHeldLines(ctx: Ctx, home: string): string[] {
  const lines = allHeldLines(ctx);
  const file = heldFile(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lines, null, 2)}\n`);
  renameSync(tmp, file);
  return lines;
}

/**
 * Writes the Held lines now and again after each change to a project's playbook or lead. A failed write is logged and the
 * next change tries again. Answers the unsubscribe.
 */
export function watchHeldLines(ctx: Ctx, home: string, log: { error: (message: string) => void }): () => void {
  const rewrite = () => {
    try {
      writeHeldLines(ctx, home);
    } catch (err) {
      log.error(`Could not write the playbooks' Held lines to ${heldFile(home)}: ${(err as Error).message}`);
    }
  };
  rewrite();
  const listener = (e: { type: string; data?: unknown }) => {
    if (e.type !== 'project.updated' && e.type !== 'project.deleted' && e.type !== 'project.restored') return;
    const changes = (e.data as { changes?: Record<string, unknown> } | undefined)?.changes;
    if (e.type === 'project.updated' && (changes === undefined || (!('playbook' in changes) && !('lead' in changes)))) return;
    rewrite();
  };
  ctx.bus.on('event', listener);
  return () => {
    ctx.bus.off('event', listener);
  };
}
