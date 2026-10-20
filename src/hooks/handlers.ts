import { join } from 'node:path';
import { ID_MAX, TASK_ID_MAX, noticeTasks, text } from '../core/notices';
import type { TitleDemand } from '../core/title';
import { SCRIBE_AGENT, WORK_STATUSES, type HookEvent } from '../core/types';
import { detectBranch } from '../lib/git';
import { homeDir } from '../lib/home';
import { appendLog } from '../lib/log';
import { readTranscriptTitle } from '../lib/transcript';
import { scrub } from './capture';

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
  stop_hook_active?: unknown;
  [key: string]: unknown;
}

export interface HookDeps {
  post: (path: string, body: unknown) => Promise<{ tracked: boolean; context?: string; title?: TitleDemand }>;
  ensureServer: () => Promise<boolean>;
}

/** What a hook prints: a context event's briefing, or a stop's block reason. Never both. */
export interface HookOutput {
  context?: string;
  block?: string;
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
    // Only the notice's task blocks leave (id, status, exit code), never its text.
    if (notice) {
      const tasks = noticeTasks(stripPasted(raw));
      if (tasks.length) body.tasks = tasks;
    }
  }
  // The session's running background tasks, so the server can end the rows that are gone. An empty array is sent too:
  // it says nothing is running.
  if (name === 'stop' && Array.isArray(input.background_tasks)) {
    const { tasks, truncated } = stoppedBackground(input.background_tasks);
    body.background = tasks;
    // The server must not reconcile against a list that was cut: it would end commands that are still running.
    if (truncated) body.backgroundTruncated = true;
  }
  // True in the extra pass a block caused: the server must not block again. Sent only when true (the server acts on
  // nothing else), so an ordinary stop's body stays exactly what an older server accepts.
  if (name === 'stop' && input.stop_hook_active === true) body.stopHookActive = true;
  // The title channel runs only in the desktop app, where set_session_title exists; a CLI session can carry a /rename
  // title too. Claude Code hands its hooks its own environment. Flagged only when true, as above.
  if ((name === 'prompt-submit' || name === 'stop') && process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') body.desktop = true;
  if (name === 'subagent-start' || name === 'subagent-stop') {
    if (input.agent_id) body.agentId = input.agent_id;
    if (typeof input.agent_type === 'string') body.agentType = input.agent_type;
  }
  return body;
}

/** Mirror the server's hookBody limits for the live-work fields (src/server/schemas.ts). */
const DESCRIPTION_MAX = 200;
/** In `.length` units, as zod counts them: a longer purpose is cut to one less, plus "…". */
const PURPOSE_MAX = 200;
const SUBJECT_MAX = 300;
const MODEL_MAX = 100;
const KEY_MAX = 100;
const BLOCKS_MAX = 100;
/** Mirror the server's hookBody limits for background work (src/server/schemas.ts). ID_MAX, TASK_ID_MAX and `text` live in core/notices. */
const HEAD_MAX = 60;
const HEAD_WORDS = 3;
/** The one-letter flags that take a value as their next word (`-C dir`, `-o opt`, `-i key`); other short flags stand alone. */
const FLAG_WITH_VALUE = /^-[CcdeFfHimopiu]$/;
const TASK_TYPE_MAX = 40;
const BACKGROUND_MAX = 50;
const DURATION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** Claude Code's background task ids: a letter, then lowercase letters and digits ("bc802pkev"). */
const BACKGROUND_ID = /^[a-z][a-z0-9]{5,39}$/;
/** The Agent tool, under its current name and its old one. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TASK_STATUSES: readonly string[] = [...WORK_STATUSES, 'deleted'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
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

/**
 * What a subagent is for, from its Agent prompt: the first non-blank line, cut after its first sentence end (`.`, `?` or
 * `!`, then a space or the end), at most 200 characters with "…". Nothing for a blank prompt. The rest of the prompt
 * never leaves Claude Code.
 */
export function purposeOf(prompt: string): string | undefined {
  const line = prompt.split(/\r?\n/).find((l) => l.trim())?.trim();
  if (!line) return undefined;
  const end = /[.?!](?=\s|$)/.exec(line);
  const sentence = end ? line.slice(0, end.index + 1) : line;
  return sentence.length > PURPOSE_MAX ? `${sentence.slice(0, PURPOSE_MAX - 1)}…` : sentence;
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
 * The live-work body a tool hook posts, or nothing to post. pre-tool on the Agent tool: a dispatch, with the prompt's
 * first sentence as its purpose (purposeOf). post-tool on the Agent tool: the launched agent's id; on TaskCreate /
 * TaskUpdate: the task change. The rest of a prompt and a task's description are never sent, and the scribe's own
 * dispatches are skipped (SubagentStart ignores the scribe too).
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
      // Every Agent call has a prompt: anything else under these names is not a dispatch. Only its first sentence leaves
      // here, as the purpose; a blank prompt sends none, so the body stays what an older server accepts.
      if (typeof toolInput.prompt !== 'string') return undefined;
      const body: Record<string, unknown> = { event: 'agent-dispatch', toolUseId, agentType, description: text(toolInput.description, DESCRIPTION_MAX) ?? '' };
      const model = text(toolInput.model, MODEL_MAX);
      if (model) body.model = model;
      const purpose = purposeOf(toolInput.prompt);
      if (purpose) body.purpose = purpose;
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
  if (tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor') {
    const monitor = tool === 'Monitor';
    const taskId = monitor ? monitorId(response) : backgroundShellId(response);
    if (!taskId) return undefined;
    const body: Record<string, unknown> = { event: 'command-started', taskId, kind: monitor ? 'monitor' : 'shell' };
    const toolUseId = text(input.tool_use_id, ID_MAX);
    if (toolUseId) body.toolUseId = toolUseId;
    if (monitor) body.persistent = isRecord(response) && typeof response.persistent === 'boolean' ? response.persistent : toolInput.persistent === true;
    const description = text(toolInput.description, DESCRIPTION_MAX);
    if (description) body.description = description;
    const head = typeof toolInput.command === 'string' ? commandHead(toolInput.command) : undefined;
    if (head) body.commandHead = head;
    const durationMs = durationOf(input.duration_ms);
    if (durationMs !== undefined) body.durationMs = durationMs;
    return { ...body, ...agent };
  }
  if (tool === 'TaskStop') {
    // The target is the stopped task, not the caller: the caller's agent_id is not sent.
    const stopped = text(isRecord(response) ? response.task_id : undefined, TASK_ID_MAX) ?? text(toolInput.task_id, TASK_ID_MAX);
    const type = isRecord(response) && typeof response.task_type === 'string' ? response.task_type : '';
    if (!stopped) return undefined;
    if (type === 'local_bash' || type.includes('monitor')) return { event: 'command-ended', taskId: stopped, outcome: 'killed' };
    if (type === 'local_agent') return { event: 'agent-ended', agentId: stopped, reason: 'killed' };
    return undefined;
  }
  if (tool === 'SendMessage') {
    // A subagent messaging a sibling would move it under the main session's focus: only the main thread's calls count.
    if (agentId) return undefined;
    if (!isRecord(response) || response.success !== true) return undefined;
    const resumedId = text(response.resumedAgentId, ID_MAX);
    const target = resumedId ?? (isRecord(response.pin) ? text(response.pin.id, ID_MAX) : undefined);
    if (!target) return undefined;
    const body: Record<string, unknown> = { event: 'agent-messaged', agentId: target, resumed: !!resumedId };
    const summary = text(toolInput.summary, DESCRIPTION_MAX);
    if (summary) body.summary = summary;
    // Only the message's first sentence leaves, as purposeOf cuts it; the rest stays in Claude Code.
    const message = typeof toolInput.message === 'string' ? toolInput.message : typeof toolInput.content === 'string' ? toolInput.content : undefined;
    const purpose = message === undefined ? undefined : purposeOf(message);
    if (purpose) body.purpose = purpose;
    return body;
  }
  return undefined;
}

/** The id a Bash or PowerShell call was given when it went to the background: the response's field, or the text's "running in background with ID: …". */
function backgroundShellId(response: unknown): string | undefined {
  const id = isRecord(response) ? response.backgroundTaskId : /running in background with ID:\s*([a-z][a-z0-9]{5,39})\b/.exec(responseText(response))?.[1];
  return typeof id === 'string' && BACKGROUND_ID.test(id) ? id : undefined;
}

/** A Monitor's task id: the response object's taskId, or "Monitor started (task …" in its text. */
function monitorId(response: unknown): string | undefined {
  const id = isRecord(response) ? response.taskId : /Monitor started \(task ([a-z][a-z0-9]{5,39})\b/.exec(responseText(response))?.[1];
  return typeof id === 'string' && BACKGROUND_ID.test(id) ? id : undefined;
}

/** How long the tool call took, when it is a number the server accepts. */
const durationOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= DURATION_MAX_MS ? Math.round(v) : undefined);

/** Where a set-up segment of a command ends: the first `;` or newline (and `&&` when andAnd) outside quotes, as [index, length]. */
function segmentEnd(s: string, andAnd: boolean): [number, number] | undefined {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ';' || c === '\n') return [i, 1];
    else if (andAnd && c === '&' && s[i + 1] === '&') return [i, 2];
  }
  return undefined;
}

/**
 * A background command's first words, to name it without sending it: set-up segments dropped (cd, pushd, Set-Location,
 * a PowerShell assignment, export), the rest cut at the first quote, pipe, redirect or separator, then the words with
 * NAME=value words and flags (and a one-letter flag's value) dropped. At most 3 words and 60 characters.
 */
export function commandHead(command: string): string | undefined {
  let rest = command;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith('#')) {
      const nl = rest.indexOf('\n');
      rest = nl < 0 ? '' : rest.slice(nl + 1);
      continue;
    }
    const cd = /^(?:cd|pushd|push-location|set-location|sl)(?=\s)/i.test(rest);
    if (!cd && !/^\$(?:\{[^}]*\}|[\w:]+)\s*=/.test(rest) && !/^export\s+\w+=/.test(rest)) break;
    const end = segmentEnd(rest, cd);
    rest = end ? rest.slice(end[0] + end[1]) : '';
  }
  const cut = /['"`|;(\n]|&&|\d*[<>]/.exec(rest);
  // Scrubbed before the flags are dropped, so `--password hunter2` is redacted while it is still a pair.
  const words = scrub(cut ? rest.slice(0, cut.index) : rest).split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\$?[\w:{}]+=/.test(w)) continue;
    if (w.startsWith('-')) {
      if (FLAG_WITH_VALUE.test(w) && words[i + 1] && !words[i + 1].startsWith('-')) i++;
      continue;
    }
    kept.push(w);
  }
  const head = kept.slice(0, HEAD_WORDS).join(' ');
  if (!head) return undefined;
  return head.length > HEAD_MAX ? `${head.slice(0, HEAD_MAX - 1)}…` : head;
}

/**
 * The Stop hook's background_tasks, reduced to what the server reconciles with: no command, only its head. A task whose
 * status is a string other than running or pending is gone and skipped. Past 50 entries the rest is cut and `truncated`
 * says so.
 */
function stoppedBackground(tasks: unknown[]): { tasks: Record<string, unknown>[]; truncated: boolean } {
  const out: Record<string, unknown>[] = [];
  for (const t of tasks) {
    if (!isRecord(t)) continue;
    if (typeof t.status === 'string' && t.status !== 'running' && t.status !== 'pending') continue;
    const taskId = text(t.id, TASK_ID_MAX);
    const type = text(t.type, TASK_TYPE_MAX);
    if (!taskId || !type) continue;
    if (out.length === BACKGROUND_MAX) return { tasks: out, truncated: true };
    const entry: Record<string, unknown> = { taskId, type };
    const description = text(t.description, DESCRIPTION_MAX);
    if (description) entry.description = description;
    const head = typeof t.command === 'string' ? commandHead(t.command) : undefined;
    if (head) entry.commandHead = head;
    out.push(entry);
  }
  return { tasks: out, truncated: false };
}

export async function runHandler(name: HookName, input: HookStdin, deps: HookDeps): Promise<HookOutput | undefined> {
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
  if (CONTEXT_EVENT_NAME[name]) return result.context ? { context: result.context } : undefined;
  if (name === 'stop' && result.title) {
    const { title, reason } = result.title;
    return { block: `Set this session's title to "${title}" with mcp__ccd_session_mgmt__set_session_title on "self" (InProgress: ${reason}), then stop.` };
  }
  return undefined;
}
