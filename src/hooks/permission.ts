import type { HookStdin } from './handlers';
import { commandOf, holdCommand, type LeadHookDeps } from './hold';

/** How long the permission hook waits for the lead's verdict: the server waits 170 s, and the hook's timeout is 180 s. */
export const STUCK_POST_MS = 175_000;

/** A PermissionRequest answer. A deny carries the message the session reads; an allow needs none. */
export function permissionDecision(behavior: 'allow' | 'deny', message?: string) {
  const decision = behavior === 'deny' ? { behavior, message: message ?? '' } : { behavior };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/**
 * The permission hook (PermissionRequest): a Bash or PowerShell command on the hold list is refused as the hold hook refuses
 * it (and left to the prompt when the check clears it). Any other request is put on the lead's desk as a `stuck` item and
 * waits for his verdict: allow or deny, or undefined to print nothing so the prompt shows as it does today (also when the
 * server does not answer).
 */
export async function runPermission(input: HookStdin, deps: LeadHookDeps | undefined): Promise<object | undefined> {
  if (deps === undefined) return undefined;
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const command = tool === 'Bash' || tool === 'PowerShell' ? commandOf(input) : undefined;
  if (command !== undefined) {
    const held = await holdCommand(command, input, deps);
    if (held !== undefined) return held.held ? permissionDecision('deny', held.reason) : undefined;
  }
  let answer: unknown;
  try {
    answer = await deps.post('/api/lead/stuck', { sessionId: input.session_id ?? null, cwd: input.cwd ?? '', toolName: tool, toolInput: input.tool_input ?? null }, STUCK_POST_MS);
  } catch {
    // InProgress not answering: the prompt shows as it does without the lead.
    return undefined;
  }
  const a = answer as { behavior?: unknown; message?: unknown } | undefined;
  if (a?.behavior !== 'allow' && a?.behavior !== 'deny') return undefined;
  return permissionDecision(a.behavior, typeof a.message === 'string' ? a.message : undefined);
}
