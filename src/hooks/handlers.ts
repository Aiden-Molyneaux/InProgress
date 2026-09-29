import type { HookEvent } from '../core/types';
import { detectBranch } from '../lib/git';
import { readTranscriptTitle } from '../lib/transcript';

export const HOOK_NAMES = ['session-start', 'prompt-submit', 'stop', 'notification', 'subagent-start', 'subagent-stop', 'session-end'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

const EVENT_FOR: Record<HookName, HookEvent> = {
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

export function buildHookBody(name: HookName, input: HookStdin): Record<string, unknown> {
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
    const prompt = stripPasted(typeof input.prompt === 'string' ? input.prompt : '');
    body.mentionsInProgress = MENTIONS.test(prompt);
    body.asksStatus = ASKS_STATUS.test(prompt);
  }
  if (name === 'subagent-start' || name === 'subagent-stop') {
    if (input.agent_id) body.agentId = input.agent_id;
    if (typeof input.agent_type === 'string') body.agentType = input.agent_type;
  }
  return body;
}

export async function runHandler(name: HookName, input: HookStdin, deps: HookDeps): Promise<string | undefined> {
  if (!input.session_id) return undefined;
  if (name === 'session-start') await deps.ensureServer();
  const result = await deps.post(`/api/sessions/${encodeURIComponent(input.session_id)}/hook`, buildHookBody(name, input));
  return CONTEXT_EVENT_NAME[name] ? result.context : undefined;
}
