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

const MENTIONS = /\binprogress\b/i;
const ASKS_STATUS = /\b(where are we|where were we|what'?s next|what'?s left|status update|project status|progress so far)\b/i;

export function stripPasted(prompt: string): string {
  return prompt.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/gi, '');
}

export function buildHookBody(name: HookName, input: HookStdin): Record<string, unknown> {
  const body: Record<string, unknown> = { event: EVENT_FOR[name] };
  if (input.transcript_path) body.transcriptPath = input.transcript_path;
  if (name === 'session-start') {
    if (input.source) body.source = input.source;
    if (input.cwd) {
      body.cwd = input.cwd;
      body.branch = detectBranch(input.cwd) ?? null;
    }
  }
  if (name === 'session-start' || name === 'prompt-submit' || name === 'stop') {
    const title = (typeof input.session_title === 'string' && input.session_title.trim()) || (input.transcript_path ? readTranscriptTitle(input.transcript_path) : undefined);
    if (title) body.title = title;
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
