import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { heldActions } from '../core/hold';
import type { HookStdin } from './handlers';

/** How long the hold hook waits for InProgress's answer before it holds the command anyway. */
export const HOLD_POST_MS = 10_000;

/** What the hold and permission hooks need from outside: the server, and the playbooks' Held lines. */
export interface LeadHookDeps {
  /** POSTs to the server with its own timeout; rejects when it does not answer, or answers an error. */
  post: (path: string, body: unknown, timeoutMs: number) => Promise<unknown>;
  /** The Held lines of every project with a lead, as `<home>/lead/held.json` holds them. */
  heldLines: () => string[];
}

/** The file the server writes the playbooks' Held lines to, under the data folder. */
export const heldFile = (home: string): string => join(home, 'lead', 'held.json');

/** The Held lines in `<home>/lead/held.json`: an array of strings. A missing or bad file is an empty list. */
export function readHeldLines(home: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(heldFile(home), 'utf8'));
  } catch {
    // No file yet (no playbook holds anything, or the server never wrote it) or a broken one: P3's list alone still holds.
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : [];
}

/** The session is told this when the command is held: it must neither retry nor work around it. */
export const heldReason = (what: string): string => `Held for Aiden before it runs: ${what}. It waits for his word. Do not retry it and do not try another way.`;

/** The same refusal when InProgress did not answer: a command on the list fails closed. */
export const unansweredReason = (what: string): string =>
  `Held for Aiden before it runs: ${what}. InProgress is not answering, so this waits for Aiden. Do not retry it and do not try another way.`;

/** The command of a Bash or PowerShell call, or undefined. */
export function commandOf(input: HookStdin): string | undefined {
  const toolInput = input.tool_input;
  if (typeof toolInput !== 'object' || toolInput === null) return undefined;
  const command = (toolInput as { command?: unknown }).command;
  return typeof command === 'string' && command.trim() !== '' ? command : undefined;
}

/**
 * Whether the command is held: undefined when nothing in it is on the list (the server is not asked); else each command of
 * it on the list is asked about in turn, and the first one held is the answer. The server not answering, or answering
 * anything but `say: nothing` or a held text, holds it.
 */
export async function holdCommand(command: string, input: HookStdin, deps: LeadHookDeps): Promise<{ held: false } | { held: true; reason: string } | undefined> {
  let extra: string[];
  try {
    extra = deps.heldLines();
  } catch {
    // An unreadable list of Held lines leaves P3's own list, which still holds what it names.
    extra = [];
  }
  const matches = heldActions(command, extra);
  if (matches.length === 0) return undefined;
  for (const match of matches) {
    let answer: unknown;
    try {
      answer = await deps.post('/api/lead/hold', { sessionId: input.session_id ?? null, cwd: input.cwd ?? '', command, action: match.action }, HOLD_POST_MS);
    } catch {
      return { held: true, reason: unansweredReason(match.what) };
    }
    const a = answer as { say?: unknown; held?: unknown; text?: unknown } | undefined;
    if (a?.held === true && typeof a.text === 'string' && a.text.trim() !== '') return { held: true, reason: heldReason(a.text) };
    if (a?.say !== 'nothing') return { held: true, reason: unansweredReason(match.what) };
  }
  return { held: false };
}

/** The PreToolUse refusal Claude Code honours in every permission mode. */
export const preToolDeny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

/**
 * The hold hook (PreToolUse on Bash and PowerShell, started only for the watched families by HOOK_DEFS' `if` rules): what
 * it prints, or undefined to print nothing and let the command go on to the ordinary permission rules.
 */
export async function runHold(input: HookStdin, deps: LeadHookDeps | undefined): Promise<object | undefined> {
  const command = commandOf(input);
  if (command === undefined) return undefined;
  const result = await holdCommand(command, input, deps ?? missingDeps);
  return result?.held ? preToolDeny(result.reason) : undefined;
}

/** Without a way to reach the server, a command on the list is held as if it did not answer. */
const missingDeps: LeadHookDeps = {
  post: () => Promise.reject(new Error('the hook has no way to reach InProgress')),
  heldLines: () => [],
};
