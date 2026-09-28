export const NODE_KINDS = ['goal', 'phase', 'task', 'question'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const NODE_STATUSES = ['todo', 'active', 'done', 'blocked', 'dropped'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];
export const ASSIGNEES = ['claude', 'me'] as const;
export type Assignee = (typeof ASSIGNEES)[number];
export const RESOURCE_KINDS = ['doc', 'test-suite', 'runbook', 'roadmap', 'diagram', 'link', 'other'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const SESSION_STATES = ['working', 'idle', 'permission', 'ended'] as const;
export type SessionState = (typeof SESSION_STATES)[number];
export const HOOK_EVENTS = ['start', 'prompt', 'stop', 'permission', 'subagent-start', 'subagent-stop', 'end'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export const SCRIBE_AGENT = 'inprogress-scribe';
export const STALE_SESSION_MS = 12 * 60 * 60 * 1000;

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

export function sessionDisplayTitle(s: Pick<Session, 'id' | 'title'>): string {
  return s.title?.trim() || `Session ${s.id.slice(0, 6)}`;
}
