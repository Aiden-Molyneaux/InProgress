import { join } from 'node:path';
import { SCRIBE_AGENT, WORK_STATUSES, type HookEvent } from '../core/types';
import { detectBranch } from '../lib/git';
import { homeDir } from '../lib/home';
import { appendLog } from '../lib/log';
import { readTranscriptTitle } from '../lib/transcript';

export const HOOK_NAMES = ['session-start', 'prompt-submit', 'stop', 'notification', 'subagent-start', 'subagent-stop', 'session-end', 'pre-tool', 'post-tool'] as const;
export type HookName = (typeof HOOK_NAMES)[number];
/** PreToolUse and PostToolUse: what they post (if anything) depends on the tool. */
export type ToolHookName = 'pre-tool' | 'post-tool';
export const isToolHook = (name: HookName): name is ToolHookName => name === 'pre-tool' || name === 'post-tool';

const EVENT_FOR: Record<Exclude<HookName, ToolHookName>, HookEvent> = {
  'session-start': 'start',
  'prompt-submit': 'prompt',
  stop: 'stop',
  notification: 'permission',
  'subagent-start': 'subagent-start',
  'subagent-stop': 'subagent-stop',
  'session-end': 'end',
};

export const CONTEXT_EVENT_NAME: Partial<Record<HookName, string>> = {
  'session-start': 'SessionStart',
  'prompt-submit': 'UserPromptSubmit',
};

export interface HookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  session_title?: string;
  prompt?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  [key: string]: unknown;
}

export interface HookDeps {
  post: (path: string, body: unknown) => Promise<{ tracked: boolean; context?: string }>;
  ensureServer: () => Promise<boolean>;
}

/** Mirrors the `title` max in the server's hookBody zod schema: a longer title gets the whole hook POST rejected. */
const TITLE_MAX = 300;
/** Mirror the server's hookBody limits for cwd and branch (src/server/schemas.ts). */
const CWD_MAX = 1_000;
const BRANCH_MAX = 300;

const MENTIONS = /\binprogress\b/i;
/**
 * How Claude Code delivers background-task results (task notifications, subagent hand-backs) as a turn. The wording
 * the hook sees can differ from the transcript's, so every known opening counts; runHandler logs any other prompt
 * that opens like markup, to catch a new format.
 */
const NOTICE =
  /^\s*(?:<task-notification\b|<agent-message\b|<system-reminder\b|Another Claude session sent a message\b|\[SYSTEM NOTIFICATION\b|\[Subagent hand-back\])/;
const MARKUP_OPENING = /^\s*[<[]/;
// A lone "status" may end in one "?"; the optional group keeps a long whitespace run linear, not quadratic.
const ASKS_STATUS = /\b(where are we|where were we|what['’]?s next|what['’]?s left|what['’]?s the status|status update|status check|project status|progress so far)\b|^\s*status(?:\s*\?)?\s*$/i;

/** The hook's stdin JSON. A leading BOM (PowerShell pipes add one) is dropped, and empty input reads as {}. */
export function parseHookInput(raw: string): HookStdin {
  const text = raw.replace(/^\uFEFF/, '').trim();
  return text ? (JSON.parse(text) as HookStdin) : {};
}

/** The hooks.log line for a failure. An ApiClientError's hint names the fix, e.g. the failing field of a 400. */
export function hookErrorLine(name: HookName, err: unknown): string {
  const hint = (err as { hint?: unknown } | null | undefined)?.hint;
  return `${name}: ${err instanceof Error ? err.message : String(err)}${typeof hint === 'string' ? ` (${hint})` : ''}`;
}

export function stripPasted(prompt: string): string {
  return prompt.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/gi, '');
}

export function buildHookBody(name: Exclude<HookName, ToolHookName>, input: HookStdin): Record<string, unknown> {
  const body: Record<string, unknown> = { event: EVENT_FOR[name] };
  if (input.transcript_path) body.transcriptPath = input.transcript_path;
  if (name === 'session-start' && input.source) body.source = input.source;
  // Prompts carry the folder too, so the server can still pick up a session whose start it missed. Values past the
  // server's limits are left out rather than clipped (a clipped path names another folder), so the post still lands.
  if ((name === 'session-start' || name === 'prompt-submit') && input.cwd && input.cwd.length <= CWD_MAX) {
    body.cwd = input.cwd;
    const branch = detectBranch(input.cwd);
    body.branch = branch && branch.length <= BRANCH_MAX ? branch : null;
  }
  if (name === 'session-start' || name === 'prompt-submit' || name === 'stop') {
    const title = (typeof input.session_title === 'string' && input.session_title.trim()) || (input.transcript_path ? readTranscriptTitle(input.transcript_path) : undefined);
    if (title) body.title = title.slice(0, TITLE_MAX);
  }
  if (name === 'prompt-submit') {
    const raw = typeof input.prompt === 'string' ? input.prompt : '';
    // A background agent finishing reaches UserPromptSubmit like a typed prompt; flagged only when true, so a
    // normal prompt's body stays exactly what an older server accepts.
    const notice = NOTICE.test(raw);
    if (notice) body.notice = true;
    const prompt = notice ? '' : stripPasted(raw);
    body.mentionsInProgress = MENTIONS.test(prompt);
    body.asksStatus = ASKS_STATUS.test(prompt);
  }
  if (name === 'subagent-start' || name === 'subagent-stop') {
    if (input.agent_id) body.agentId = input.agent_id;
    if (typeof input.agent_type === 'string') body.agentType = input.agent_type;
  }
  return body;
}

/** Mirror the server's hookBody limits for the live-work fields (src/server/schemas.ts). */
const DESCRIPTION_MAX = 200;
const SUBJECT_MAX = 300;
const MODEL_MAX = 100;
const KEY_MAX = 100;
const ID_MAX = 200;
const BLOCKS_MAX = 100;
/** The Agent tool, under its current name and its old one. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TASK_STATUSES: readonly string[] = [...WORK_STATUSES, 'deleted'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A non-blank string, trimmed and clipped, else nothing. */
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
/** A task id: Claude Code sends strings ("3"), but a number reads the same. */
const taskKey = (v: unknown): string | undefined => (typeof v === 'number' && Number.isFinite(v) ? String(v) : text(v, KEY_MAX));
const taskKeys = (v: unknown): string[] => (Array.isArray(v) ? v.map(taskKey).filter((k): k is string => !!k).slice(0, BLOCKS_MAX) : []);

/** A tool response's text: a string, content blocks, or an object that holds content blocks. */
function responseText(response: unknown): string {
  if (typeof response === 'string') return response;
  const blocks = Array.isArray(response) ? response : isRecord(response) && Array.isArray(response.content) ? response.content : [];
  return blocks.map((b) => (isRecord(b) && typeof b.text === 'string' ? b.text : '')).join('\n');
}

/** A launch response's model id, short: "claude-opus-5[1m]" → "opus-5", "claude-haiku-4-5-20251001" → "haiku-4-5". */
export function shortModel(id: string): string | undefined {
  return text(id.trim().replace(/\[[^\]]*\]$/, '').replace(/^claude-/, '').replace(/-\d{8}$/, ''), MODEL_MAX);
}

/** The launched agent's id: the response object's agentId, or the "agentId: …" line of its text. */
function launchedAgentId(response: unknown): string | undefined {
  if (isRecord(response)) {
    const id = text(response.agentId, ID_MAX);
    if (id) return id;
  }
  return /\bagentId:\s*([\w-]{1,200})/.exec(responseText(response))?.[1];
}

/** TaskCreate's new id: `{ task: { id } }`, or "Task #3 created successfully" as text. */
function createdTaskKey(response: unknown): string | undefined {
  if (isRecord(response) && isRecord(response.task)) {
    const key = taskKey(response.task.id);
    if (key) return key;
  }
  return /\bTask #([\w-]{1,100}) created\b/.exec(responseText(response))?.[1];
}

/**
 * The live-work body a tool hook posts, or nothing to post. pre-tool on the Agent tool: a dispatch. post-tool on the
 * Agent tool: the launched agent's id; on TaskCreate / TaskUpdate: the task change. A prompt and a task's description
 * are never sent, and the scribe's own dispatches are skipped (SubagentStart ignores the scribe too).
 */
export function buildToolHookBody(name: ToolHookName, input: HookStdin): Record<string, unknown> | undefined {
  const tool = input.tool_name;
  const toolInput = input.tool_input;
  if (typeof tool !== 'string' || !isRecord(toolInput)) return undefined;
  if (AGENT_TOOLS.has(tool)) {
    const toolUseId = text(input.tool_use_id, ID_MAX);
    // Without a subagent_type the Agent tool runs a general-purpose agent.
    const agentType = text(toolInput.subagent_type, ID_MAX) ?? 'general-purpose';
    if (!toolUseId || agentType === SCRIBE_AGENT) return undefined;
    if (name === 'pre-tool') {
      // Every Agent call has a prompt: anything else under these names is not a dispatch. The prompt itself stays here.
      if (typeof toolInput.prompt !== 'string') return undefined;
      const body: Record<string, unknown> = { event: 'agent-dispatch', toolUseId, agentType, description: text(toolInput.description, DESCRIPTION_MAX) ?? '' };
      const model = text(toolInput.model, MODEL_MAX);
      if (model) body.model = model;
      return body;
    }
    const agentId = launchedAgentId(input.tool_response);
    if (!agentId) return undefined;
    const body: Record<string, unknown> = { event: 'agent-launched', toolUseId, agentId };
    const response = input.tool_response;
    const model = isRecord(response) && typeof response.resolvedModel === 'string' ? shortModel(response.resolvedModel) : undefined;
    if (model) body.model = model;
    return body;
  }
  if (name !== 'post-tool') return undefined;
  // Inside a subagent the hook input names it: the task belongs to that agent's own list.
  const agentId = text(input.agent_id, ID_MAX);
  const agent = agentId ? { agentId } : {};
  const response = input.tool_response;
  if (tool === 'TaskCreate') {
    const key = createdTaskKey(response);
    const subject = text(toolInput.subject, SUBJECT_MAX) ?? (isRecord(response) && isRecord(response.task) ? text(response.task.subject, SUBJECT_MAX) : undefined);
    return key && subject ? { event: 'task-created', taskKey: key, subject, ...agent } : undefined;
  }
  if (tool === 'TaskUpdate') {
    const key = taskKey(toolInput.taskId);
    if (!key || (isRecord(response) && response.success === false)) return undefined;
    const body: Record<string, unknown> = { event: 'task-updated', taskKey: key, ...agent };
    if (typeof toolInput.status === 'string' && TASK_STATUSES.includes(toolInput.status)) body.status = toolInput.status;
    const subject = text(toolInput.subject, SUBJECT_MAX);
    if (subject) body.subject = subject;
    const blocks = taskKeys(toolInput.addBlocks);
    if (blocks.length) body.addBlocks = blocks;
    const blockedBy = taskKeys(toolInput.addBlockedBy);
    if (blockedBy.length) body.addBlockedBy = blockedBy;
    return body;
  }
  return undefined;
}

export async function runHandler(name: HookName, input: HookStdin, deps: HookDeps): Promise<string | undefined> {
  if (!input.session_id) return undefined;
  if (isToolHook(name)) {
    // Silent: a tool hook never prints, so it can never steer the tool call.
    const body = buildToolHookBody(name, input);
    if (body) await deps.post(`/api/sessions/${encodeURIComponent(input.session_id)}/hook`, body);
    return undefined;
  }
  if (name === 'session-start') await deps.ensureServer();
  const body = buildHookBody(name, input);
  if (name === 'prompt-submit' && !body.notice && typeof input.prompt === 'string' && MARKUP_OPENING.test(input.prompt)) {
    // Not a recognised notice but shaped like one: record its opening so a new notice format can be added.
    appendLog(join(homeDir(), 'hooks.log'), `prompt-submit: counted a prompt that opens like markup: ${JSON.stringify(input.prompt.slice(0, 80))}`);
  }
  const result = await deps.post(`/api/sessions/${encodeURIComponent(input.session_id)}/hook`, body);
  return CONTEXT_EVENT_NAME[name] ? result.context : undefined;
}
