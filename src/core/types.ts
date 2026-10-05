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
export const NODE_STATUSES = ['todo', 'active', 'done', 'blocked', 'dropped'] as const;
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
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
/** A working task's status, as Claude Code's task tools have it (their `deleted` removes the task instead). */
export const WORK_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
export const SCRIBE_AGENT = 'inprogress-scribe';
export const STALE_SESSION_MS = 12 * 60 * 60 * 1000;
/** How long ended work stays on its step as the trail: an ended session's working tasks, and a subagent after it stopped. */
export const TRAIL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long a live session's stopped worker keeps its greyed badge: five minutes, then it shows in the trail. A reader
 * keeps none: it shows only while it runs, and leaves no trail (agentVisible in core/layout). The server's list of a
 * session's subagents keeps a stopped one this long too (listSubagents).
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

export interface ProjectSummary extends Project {
  needsYou: number;
  activeSessions: number;
  workingSessions: number;
  lastEventAt: string | null;
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
}

export interface Resource extends ResourceMeta {
  content: string | null;
}

export interface LogEntry {
  id: number;
  nodeId: number;
  text: string;
  sessionId: string | null;
  createdAt: string;
  sessionTitle: string | null;
}

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  startedAt: string;
  /** The Agent tool call's description (at most 200 characters); null until the subagent is paired with its dispatch. */
  description: string | null;
  /** The model it was dispatched with, or the one its launch reported; null when neither is known. */
  model: string | null;
  /** The node it works on: the `#id` its description starts with, else the session's focus at dispatch. */
  nodeId: number | null;
  /** Set when it stopped, or when its session ended. A session's list keeps an ended subagent for 5 minutes. */
  endedAt: string | null;
  /** Its number within its session, given at its start (the 1 in `a1`); null for a subagent from before migration 4. */
  ordinal: number | null;
  /**
   * What it was asked to do: the first sentence of its Agent prompt, at most 200 characters. Null until it is paired
   * with its dispatch, for a blank prompt, and for a subagent from before migration 5.
   */
  purpose: string | null;
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
  endedAt: string;
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
  endedAt: string | null;
  /**
   * Its identity in its project: the lowest slot no other live session there held when it began, was revived or moved.
   * Its letter (0 is A) and hue; its subagents wear them too. Null for a session from before migration 4, until its
   * next hook event fills it.
   */
  slot: number | null;
  subagents: SubagentInfo[];
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

/** A session's letter from its slot, in bijective base 26: 0 → "A", 25 → "Z", 26 → "AA"; "" for null (no slot yet). */
export function sessionTag(slot: number | null): string {
  if (slot === null) return '';
  let tag = '';
  for (let n = slot + 1; n > 0; n = Math.floor((n - 1) / 26)) tag = String.fromCharCode(65 + ((n - 1) % 26)) + tag;
  return tag;
}

/** A session's letter where an owner needs a label (an Up next line or marker): "?" while its slot is empty. */
export function ownerTag(slot: number | null): string {
  return sessionTag(slot) || '?';
}

/** "a1": the session's letter in lower case and the subagent's number; "" when either is null. */
export function agentTag(slot: number | null, ordinal: number | null): string {
  return slot === null || ordinal === null ? '' : `${sessionTag(slot).toLowerCase()}${ordinal}`;
}
