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
  /** Node ids in the order Claude plans to work on them. Done and dropped nodes are left out as it is read. */
  queue: number[];
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
}

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
