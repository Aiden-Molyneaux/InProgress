import type { TaskState } from './taskState';

export const NODE_KINDS = ['goal', 'phase', 'task', 'question'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
/** A step's type label: what kind of work it is. Pick by purpose first (fix, refactor, research), else by where the work lands. */
export const NODE_LABELS = ['ui', 'server', 'data', 'integration', 'ops', 'docs', 'fix', 'refactor', 'research'] as const;
export type NodeLabel = (typeof NODE_LABELS)[number];
/** Each label's glyph. Labels are glyph-first and never coloured: a hue would read as a status or an agent. */
export const LABEL_GLYPHS: Record<NodeLabel, string> = {
  ui: '⧉', server: '⚙', data: '⛁', integration: '⇄', ops: '⚒', docs: '¶', fix: '⚑', refactor: '↻', research: '⌕',
};
/** The refusal of a label outside the set, naming the set. */
export const unknownLabel = (value: unknown): string => `Unknown label ${JSON.stringify(value)}. Use one of: ${NODE_LABELS.join(', ')}.`;
export const NODE_STATUSES = ['todo', 'active', 'done', 'blocked', 'dropped', 'parked'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];
export const ASSIGNEES = ['claude', 'me'] as const;
export type Assignee = (typeof ASSIGNEES)[number];
export const RESOURCE_KINDS = ['doc', 'test-suite', 'runbook', 'roadmap', 'diagram', 'link', 'other'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const SESSION_STATES = ['working', 'idle', 'permission', 'ended'] as const;
export type SessionState = (typeof SESSION_STATES)[number];
export const HOOK_EVENTS = [
  'start', 'prompt', 'stop', 'permission', 'subagent-start', 'subagent-stop', 'end',
  'agent-dispatch', 'agent-launched', 'task-created', 'task-updated',
  'command-started', 'command-ended', 'agent-ended', 'agent-messaged',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
/** A working task's status, as Claude Code's task tools have it (their `deleted` removes the task instead). */
export const WORK_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
export const SCRIBE_AGENT = 'inprogress-scribe';
export const STALE_SESSION_MS = 12 * 60 * 60 * 1000;
/** How long a step's live driver may sit idle, with nothing running and no open ask, before the step is marked stalled. */
export const STALL_MS = 30 * 60 * 1000;
/** How long ended work stays on its step as the trail: an ended session's working tasks, and a subagent after it stopped. */
export const TRAIL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a Soon or Someday step may go untouched (no edit, no focusing session, no ask) before the Backlog calls it Stale. */
export const STALE_STEP_MS = 14 * 24 * 60 * 60 * 1000;
/** A step's Backlog band. There is no next band: Next up is the queue, which wins over the band while the step is in it. */
export const RANK_BANDS = ['soon', 'someday'] as const;
export type RankBand = (typeof RANK_BANDS)[number];
export const ASK_KINDS = ['question', 'permission', 'review'] as const;
export type AskKind = (typeof ASK_KINDS)[number];
export const SESSION_ROLES = ['worker', 'orchestrator'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];
export const BRIEFING_MODES = ['full', 'scoped'] as const;
export type BriefingMode = (typeof BRIEFING_MODES)[number];
/** nudge: the briefing tells a session when its title prefix is off. enforce: the Stop hook also sends it back once to set it. */
export const TITLE_CHANNELS = ['nudge', 'enforce'] as const;
export type TitleChannel = (typeof TITLE_CHANNELS)[number];
export const RESOURCE_PURPOSES = ['handoff', 'state', 'library', 'page'] as const;
export type ResourcePurpose = (typeof RESOURCE_PURPOSES)[number];
/** A doc read live from its path in a bound repo: `library` lists it in the Library, `page` in its project's Docs view. */
export const PAGE_PURPOSES = ['library', 'page'] as const satisfies readonly ResourcePurpose[];
export type PagePurpose = (typeof PAGE_PURPOSES)[number];
export const isPagePurpose = (p: string | null | undefined): p is PagePurpose => (PAGE_PURPOSES as readonly (string | null | undefined)[]).includes(p);
/** How long a cleared ask stays in the snapshot, and how old an open one is before it is stale. */
export const ASK_TRAIL_MS = 7 * 24 * 60 * 60 * 1000;
/** An ask's glyph by kind, for the window and the briefing. */
export const ASK_GLYPHS: Record<AskKind, string> = { question: '?', permission: '⚿', review: '◎' };

export interface Ask {
  id: number;
  projectId: number;
  nodeId: number;
  kind: AskKind;
  text: string;
  /** The session that raised it; null for migrated and window rows. */
  sessionId: string | null;
  raisedAt: string;
  clearedAt: string | null;
  /** The actor string write() recorded for the first clear. */
  clearedBy: string | null;
  answer: string;
  answerDeliveredAt: string | null;
}
/** "a7": how sessions, the briefing and the window name an ask. */
export const askTag = (id: number): string => `a${id}`;

/** The project's state note (the resource with purpose 'state' on the root), with its text. */
export interface StateNote {
  resourceId: number;
  updatedAt: string;
  content: string;
}

/** How long a deleted project waits under Recently deleted, restorable, before it is purged for good. */
export const DELETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long a live session's stopped worker keeps its greyed badge: five minutes, then it shows in the trail. A reader
 * keeps none: it shows only while it runs, and leaves no trail (agentVisible in core/layout). The server's list of a
 * session's subagents keeps a stopped one this long too (listSubagents). One that hit the usage limit keeps its badge
 * until it runs again or its session ends (atLimit in core/layout).
 */
export const ENDED_AGENT_MS = 5 * 60 * 1000;

export interface Project {
  id: number;
  slug: string;
  name: string;
  description: string;
  playbook: string;
  status: 'active' | 'archived';
  rootNodeId: number;
  createdAt: string;
  updatedAt: string;
  /**
   * The steps Claude plans to take next, next first: each owned by a session (its own order, set by its `queue:`) or
   * by nobody (the `later:` order). Owned entries come before unowned ones, and a node is in it once. Done and dropped
   * nodes are left out as it is read.
   */
  queue: QueueEntry[];
  briefingMode: BriefingMode;
  titleChannel: TitleChannel;
}

/**
 * One step in a project's Up next queue. Stored as `{ "node": 82, "session": "3fa9…" }`; a bare number from before
 * owned entries reads as unowned.
 */
export interface QueueEntry {
  nodeId: number;
  /** The session whose own order it is in; null when it is unowned. */
  sessionId: string | null;
}

/** One window change to the queue (spec 2.5): applied to the stored queue on the server, never a replacement list. */
export type QueueOp = { kind: 'move'; node: number; before: number | null } | { kind: 'remove'; node: number };

/**
 * One window change to a step's rank (ranked Backlog spec section 2): `next` is the queue move, before `before` in the
 * unowned queue, the band untouched; `soon` or `someday` takes it out of the queue and places it in that band before
 * `before` (null: at the end).
 */
export type RankOp = { node: number; to: 'next' | RankBand; before: number | null };

/** The longest a project's name may be, once trimmed: the server's rule, and the window's rename field. */
export const PROJECT_NAME_MAX = 120;

export interface ProjectSummary extends Project {
  /** Open asks. */
  openAsks: number;
  /** Live sessions in state permission. */
  permissionWaits: number;
  activeSessions: number;
  /** Live sessions in state working. */
  workingSessions: number;
  /**
   * Live sessions with work going on: working, or with a running worker (a subagent that is not a reader) or a background
   * command that counts as work (countsAsWork) while the session itself is idle or waiting. A tab's dot shows while any
   * is, pulsing only while one is working.
   */
  busySessions: number;
  lastEventAt: string | null;
}

/**
 * A project deleted less than 30 days ago: hidden everywhere else, restorable until `purgeAt`, when it is removed for
 * good. Newest first in its list.
 */
export interface DeletedProject {
  id: number;
  slug: string;
  name: string;
  deletedAt: string;
  /** `deletedAt` plus DELETED_RETENTION_MS. */
  purgeAt: string;
}

export interface Binding {
  id: number;
  projectId: number;
  path: string;
  branchPattern: string | null;
  createdAt: string;
}

export interface TreeNode {
  id: number;
  projectId: number;
  parentId: number | null;
  position: number;
  kind: NodeKind;
  title: string;
  body: string;
  status: NodeStatus;
  assignee: Assignee;
  outcome: string;
  /** What kind of work the step is; null when unlabelled. */
  label: NodeLabel | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** The session that drives the step while it is active; null when none does, and always once done or dropped. */
  driverSessionId: string | null;
  /** The state the server's reconcile last stored (a TaskState); null until it first runs for the step. */
  boardState: TaskState | null;
  /** When `boardState` last changed. */
  stateSince: string | null;
  /** The task hue (0-6) held while the step is in a coloured state; null otherwise. */
  hue: number | null;
  /** Why the step is parked (set aside on purpose); '' unless parked. */
  parkedReason: string;
  /** Where a parked step's work lives (a branch, worktree or commit); '' when not given or not parked. */
  parkedWhere: string;
  /** When the step was parked; null unless parked. */
  parkedAt: string | null;
  /** Its Backlog band; null when unranked (Needs Triage). Parking clears it. */
  rankBand: RankBand | null;
  /** Its place within the band, project-wide, lowest first; null sorts after the ranked steps of the band, in tree order. */
  rank: number | null;
}

export interface NodeInput {
  title: string;
  kind?: NodeKind;
  status?: NodeStatus;
  assignee?: Assignee;
  body?: string;
  outcome?: string;
  /** Omitted or null: unlabelled. */
  label?: NodeLabel | null;
  children?: NodeInput[];
}

/** Insert position among siblings: after a sibling #id, at the start, or at the end. */
export type After = number | 'start' | 'end';

export interface ResourceMeta {
  id: number;
  projectId: number;
  nodeId: number;
  kind: ResourceKind;
  title: string;
  path: string | null;
  url: string | null;
  contentLength: number;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  purpose: ResourcePurpose | null;
  /** A page's last confirmation: the owning repo's HEAD and the time. Set at registration and by Still accurate. */
  confirmedSha: string | null;
  confirmedAt: string | null;
}

export interface Resource extends ResourceMeta {
  content: string | null;
}

/** A page's front matter: YAML in markdown, `<meta name="inprogress:<key>">` in HTML. */
export interface PageFront {
  /** Paths or globs, relative to the page's repo root, that the page describes. */
  covers: string[];
  shelf: 'pages' | 'roster';
  /** Shipwright template paths the page explains. */
  templates: string[];
}

/** Commits to a page's `covers` since its confirmation; `count` is null when `confirmedSha` left the repo's history. */
export interface PageFreshness {
  count: number | null;
  confirmedSha: string | null;
  confirmedAt: string | null;
}

/** GET /api/resources/:id/body: a page as its file stands now. Markdown `text` has its front matter taken off. */
export interface PageBody {
  format: 'markdown' | 'html';
  text: string;
  front: PageFront;
  /** The owning repo's HEAD. */
  sha: string;
  /** Null when the page has no `covers`: no strip. */
  fresh: PageFreshness | null;
}

export type SyncState = 'error' | 'gone' | 'missing' | 'pending' | 'behind' | 'current';
export interface SyncCommit {
  sha: string;
  date: string;
  subject: string;
}
export interface SyncFile {
  template: string;
  /** The project's copy, relative to its folder; null when Shipwright did not say. */
  local: string | null;
  base: string | null;
  state: SyncState;
  behind: number;
  commits: SyncCommit[];
  fills: Record<string, string>;
  detail: string | null;
}
/** template-sync.mjs --check --json, as Shipwright prints it (#532). */
export interface SyncCheck {
  shipwright: { head: string; date: string; subject: string };
  project: string;
  lastSync: SyncCommit | null;
  files: SyncFile[];
  skip: string[];
  notAdopted: string[];
  fills: Record<string, string>;
}
export type SyncOutcome = { ok: true; result: SyncCheck } | { ok: false; error: string };
export interface SyncRow {
  projectId: number;
  slug: string;
  name: string;
  dir: string;
  check: SyncOutcome;
  /** The project's open sync step (the lowest id), or null. */
  syncStep: { id: number; title: string } | null;
}
/** POST /api/ui/library/sync. `noManifest`: bound projects with no manifest; `source` marks Shipwright itself. */
export interface LibrarySync {
  projects: SyncRow[];
  noManifest: { projectId: number; slug: string; name: string; source: boolean }[];
  /** Shipwright's `templates.json` list, in its order; empty when no source is readable. */
  templates: string[];
  /** The project that is Shipwright (the noManifest entry marked source), with the head the first ok row saw; null when none. */
  source: { slug: string; name: string; head: string | null } | null;
}
export interface DiffHunk {
  header: string;
  /** The last markdown heading above the hunk in the project's copy; null before the first heading. Only meaningful when `located`. */
  section: string | null;
  /** Whether the hunk was found in the project's copy. False: the copy could not be read, or no line of the hunk is in it. */
  located: boolean;
  /** An upstream hunk the three-way merge cannot apply cleanly. */
  conflict: boolean;
  /** The 1-based line of the project's copy the hunk is placed at; null when it is not `located`. */
  line: number | null;
  added: number;
  removed: number;
  lines: { kind: '+' | '-' | ' '; text: string }[];
}
/** POST /api/ui/library/sync/diff. */
export type SyncDiff =
  | {
      ok: true;
      adaptation: DiffHunk[];
      upstream: DiffHunk[];
      commits: SyncCommit[];
      /** Where the dry-run merge conflicts, as the script gives it. */
      conflictRanges: ConflictRange[];
    }
  | { ok: false; error: string };
/** A conflict of the dry-run merge: its 1-based first line and line count in the project's copy, and in the template at base. */
export interface ConflictRange {
  start: number;
  lines: number;
  base?: { start: number; lines: number };
}
/** One row of an adaptation's side by side (`sideBySide` in core/sections.ts). */
export interface AdaptRow {
  key: string;
  title: string;
  /** 2 or 3 for a heading, 0 for a bold paragraph lead, -1 for the Opening, -2 for the text a lead leaves under its heading. */
  level: number;
  tag: 'same' | 'fill' | 'file fill' | 'rewritten' | 'added' | 'removed';
  /** Shipwright's text at base, placeholders kept; null for an added section. */
  template: string | null;
  /** The copy's text; null for a removed section. */
  project: string | null;
  placeholders: string[];
  /** The next sync conflicts in this section of the copy. */
  conflict: boolean;
}
/** POST /api/ui/library/sync/adaptation: a project's Docs view of one adopted template. */
export type SyncAdaptation =
  | { ok: true; project: string; template: string; base: string; head: string; state: SyncState; behind: number; commits: SyncCommit[]; rows: AdaptRow[]; adaptation: DiffHunk[] }
  | { ok: false; error: string };
export interface LibraryPage {
  id: number;
  title: string;
  path: string;
  projectId: number;
  projectSlug: string;
  projectName: string;
  format: 'markdown' | 'html' | null;
  shelf: 'pages' | 'roster';
  templates: string[];
  /** Commits to covers since confirmed; null: confirm again; undefined: no covers. */
  fresh?: number | null;
  /** Why the page cannot be read now (gone, refused). */
  error: string | null;
  adaptedIn: { slug: string; name: string; template: string }[];
}
/** GET /api/library/pages. */
export interface LibraryPages {
  pages: LibraryPage[];
  sourceProjectId: number | null;
}
export const projectBehind = (row: SyncRow): boolean => row.check.ok && row.check.result.files.some((f) => f.state === 'behind');

export interface LogEntry {
  id: number;
  nodeId: number;
  text: string;
  sessionId: string | null;
  createdAt: string;
  sessionTitle: string | null;
}

/**
 * Why a subagent ended without a clean SubagentStop: `limit` (it hit the usage limit), `error` (another API error),
 * `killed` (stopped: TaskStop, a stopped workflow, the UI), `silent` (no new line in its transcript for 20 minutes; its
 * next line revives it), `session` (it was still running when its session ended or expired). The first four are read
 * from its own transcript by the server's watcher (agent-watch).
 */
export const END_REASONS = ['limit', 'error', 'killed', 'silent', 'session'] as const;
export type EndReason = (typeof END_REASONS)[number];

export const COMMAND_KINDS = ['shell', 'monitor'] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];
export const COMMAND_OUTCOMES = ['completed', 'failed', 'killed', 'session', 'unknown'] as const;
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number];

/** A background command (Bash, PowerShell or Monitor) a session or one of its subagents started. */
export interface CommandInfo {
  /** Claude Code's background task id (`b...`). */
  taskId: string;
  kind: CommandKind;
  /** The subagent that started it; '' for the main thread. */
  agentId: string;
  /** A persistent Monitor: never counts as work. */
  persistent: boolean;
  /** The tool call's description, at most 200 characters. */
  description: string | null;
  /** The command's first words, at most 60 characters; never the full command. */
  commandHead: string | null;
  nodeId: number | null;
  startedAt: string;
  endedAt: string | null;
  outcome: CommandOutcome | null;
  exitCode: number | null;
}

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  startedAt: string;
  /** When its current run started: `startedAt` until it is resumed. The server sends `run_started_at ?? started_at`. */
  runStartedAt: string;
  /** The Agent tool call's description (at most 200 characters); null until the subagent is paired with its dispatch. */
  description: string | null;
  /** The model it was dispatched with, or the one its launch reported; null when neither is known. */
  model: string | null;
  /**
   * The node it works on: the `#id` its description starts with, else the session's focus at dispatch, else the
   * session's focus when it started (or the first focus the session set, when it started with none). Null with none of
   * those: a subagent from before migration 7, or one whose step was deleted. The server merges them (toInfo).
   */
  nodeId: number | null;
  /** Set when it stopped, or when its session ended. A session's list keeps an ended subagent for 5 minutes. */
  endedAt: string | null;
  /** Its number within its session, given at its start; null for a subagent from before migration 4. No longer shown. */
  ordinal: number | null;
  /**
   * What it was asked to do: the first sentence of its Agent prompt, at most 200 characters. Null until it is paired
   * with its dispatch, for a blank prompt, and for a subagent from before migration 5.
   */
  purpose: string | null;
  /** Why it ended, when not by a clean stop (END_REASONS). Null while it runs and after a clean SubagentStop. */
  endReason: EndReason | null;
  /**
   * Its last sign of life, for an end the transcript watcher found (its last transcript line): "ran …" and "… ago"
   * count to it, while `endedAt` stays when InProgress noticed. Null otherwise.
   */
  lastActiveAt: string | null;
}

/** Agent types that only read. They get no badge of their own and leave no trail: a step shows them as one row. */
export const READER_AGENT_TYPES = ['Explore', 'Plan', 'claude-code-guide'] as const;
export const isReader = (agentType: string): boolean => (READER_AGENT_TYPES as readonly string[]).includes(agentType);

/**
 * A subagent that has stopped, kept 7 days as the trail on its step. The snapshot lists every one; the layout shows a
 * live session's subagent as its greyed badge for five minutes after it stops and as trail after that, and an ended
 * session's subagents as trail at once.
 */
export interface TrailAgent extends SubagentInfo {
  sessionId: string;
}

/** An ended session that a trail item or trail agent belongs to: what the trail needs to name it and place its agents. */
export interface PastSession {
  id: string;
  title: string | null;
  focusNodeId: number | null;
  startedAt: string;
  endedAt: string;
}

/**
 * When a session or an ask last touched an open step in a band (ranked Backlog spec section 4), read with no time limit:
 * `pastSessions` and the asks reach back 7 days, Stale 14. Only steps with either time are listed.
 */
export interface StepTouch {
  nodeId: number;
  /** The newest end (or last sign, while it runs) of a session whose focus is the step; null when none. */
  sessionAt: string | null;
  /** When the newest ask on the step was raised; null when none was. */
  askAt: string | null;
}

/** One of Claude's working tasks, under the node it was attributed to when it was created. */
export interface WorkItem {
  id: number;
  nodeId: number;
  sessionId: string;
  /** The subagent whose task list it is on; '' for the main session's. */
  agentId: string;
  subject: string;
  status: WorkStatus;
  /** Ids of the work items this one blocks (each renders "after <this one>"), from the same task list. */
  blocks: number[];
  /** Creation order among the node's working tasks. */
  position: number;
  updatedAt: string;
  /** When its session ended (it is trail then, kept 7 days); null while the session is live. */
  endedAt: string | null;
}

export interface Session {
  id: string;
  projectId: number | null;
  title: string | null;
  cwd: string | null;
  branch: string | null;
  transcriptPath: string | null;
  state: SessionState;
  focusNodeId: number | null;
  promptsSinceUpdate: number;
  startedAt: string;
  lastSeenAt: string;
  /** When it last got a real prompt (not a background-task notice); null before migration 14 or its first one. The Board's answered-in-chat rule reads it. */
  lastPromptAt: string | null;
  endedAt: string | null;
  /**
   * The order of a project's sessions: the lowest slot no other live session there held when it began, was revived or
   * moved. Never shown; it breaks ties in sort order. Null for a session from before migration 4, until its next hook
   * event fills it.
   */
  slot: number | null;
  role: SessionRole;
  /** The full title the session's last Stop block demanded (migration 16); null before any. */
  titleAsked: string | null;
  subagents: SubagentInfo[];
  /** Its background commands: running ones and those that ended in the last five minutes, at most 30. */
  commands: CommandInfo[];
}

export interface EventRow {
  id: number;
  ts: string;
  projectId: number | null;
  actor: string;
  type: string;
  entity: string;
  entityId: string;
  data: unknown;
}

export interface ProjectSnapshot {
  project: Project;
  nodes: TreeNode[];
  resources: ResourceMeta[];
  sessions: Session[];
  /** The working tasks of `sessions`, and of the project's sessions that ended less than 7 days ago, by node, then position. */
  workItems: WorkItem[];
  /** The project's sessions' subagents that stopped less than 7 days ago, live session or not. */
  trailAgents: TrailAgent[];
  /** The project's ended sessions that `workItems` or `trailAgents` name. */
  pastSessions: PastSession[];
  /** Open asks, and those cleared in the last 7 days, oldest raised first. */
  asks: Ask[];
  /** The last session and ask times of the open steps in a band, however old, for the Backlog's Stale view. */
  stepTouches: StepTouch[];
  stateNote: StateNote | null;
  lastEventId: number;
  lastEvent: EventRow | null;
}

export interface NodeDetail {
  node: TreeNode;
  parent: { id: number; title: string } | null;
  children: Pick<TreeNode, 'id' | 'title' | 'status' | 'assignee' | 'kind'>[];
  resources: ResourceMeta[];
  log: LogEntry[];
}

export interface SearchResult {
  nodes: Pick<TreeNode, 'id' | 'title' | 'status' | 'kind'>[];
  resources: Pick<ResourceMeta, 'id' | 'title' | 'kind' | 'nodeId'>[];
}

/** A step's title with its label's glyph in front (`⧉ Working-task rows`), or the bare title when it has none. */
export function glyphTitle(n: Pick<TreeNode, 'title' | 'label'>): string {
  const glyph = n.label ? LABEL_GLYPHS[n.label] : undefined;
  return glyph ? `${glyph} ${n.title}` : n.title;
}

export function sessionDisplayTitle(s: Pick<Session, 'id' | 'title'>): string {
  return s.title?.trim() || `Session ${s.id.slice(0, 6)}`;
}
