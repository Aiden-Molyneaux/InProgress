import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { folderInside, heldActions, type HeldMatch } from '../core/hold';
import type { HookStdin } from './handlers';

/** How long the hold hook waits for InProgress's answer before it holds the command anyway. */
export const HOLD_POST_MS = 10_000;

/** What the server leaves for the hook in `<home>/lead/held.json`. */
export interface HeldFile {
  /** Whether there is a file at all: with none, a command InProgress does not answer about is let through. */
  present: boolean;
  /** The Held lines of every project with a lead. */
  lines: string[];
  /** The bound folders of every project with a lead and its round on; null when the file does not say (the old form, a broken file). */
  folders: string[] | null;
}

/** What the hold and permission hooks need from outside: the server, and the file the server leaves them. */
export interface LeadHookDeps {
  /** POSTs to the server with its own timeout; rejects when it does not answer, or answers an error. */
  post: (path: string, body: unknown, timeoutMs: number) => Promise<unknown>;
  /** `<home>/lead/held.json`, read once per call. */
  held: () => HeldFile;
  /**
   * Told, before the first POST, what the hold hook prints if it is cut off before it answers (undefined: nothing), so
   * a timeout never lets a held command through.
   */
  fallback?: (json: object | undefined) => void;
}

/** The file the server writes the Held lines and the watched folders to, under the data folder. */
export const heldFile = (home: string): string => join(home, 'lead', 'held.json');

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A blocking wait, for a hook that has nothing else to do while it waits. */
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * `<home>/lead/held.json`: `{ lines, folders }`, or the older array of lines. A missing file is `present: false`; a broken
 * one, or the old form, says nothing of folders, so any folder counts.
 */
export function readHeld(home: string): HeldFile {
  let text: string | undefined;
  for (let attempt = 0; attempt < 2 && text === undefined; attempt++) {
    try {
      text = readFileSync(heldFile(home), 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // The server may be replacing the file at this moment (Windows says EPERM or EBUSY): look once more.
      if (attempt === 0 && (code === 'EPERM' || code === 'EBUSY')) pause(50);
      else break;
    }
  }
  if (text === undefined) {
    // No file: the server never wrote one, so no project here has the round on.
    return { present: false, lines: [], folders: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A broken file still says a server wrote one: P3's list holds, in any folder.
    return { present: true, lines: [], folders: null };
  }
  if (Array.isArray(parsed)) return { present: true, lines: strings(parsed), folders: null };
  const o = parsed as { lines?: unknown; folders?: unknown } | null;
  return { present: true, lines: strings(o?.lines), folders: Array.isArray(o?.folders) ? strings(o.folders) : null };
}

/** The Held lines alone (the installer reports those outside the watched families). */
export const readHeldLines = (home: string): string[] => readHeld(home).lines;

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
 * Whether a command on the list is held when InProgress does not answer: only where a project with the round on is bound
 * (any folder when the file does not say, and a folder that could not be read), and never with no file at all.
 */
function heldUnanswered(held: HeldFile, match: HeldMatch): boolean {
  if (!held.present) return false;
  if (held.folders === null || match.folder === null) return true;
  return held.folders.some((root) => folderInside(match.folder!, root));
}

/**
 * Whether the command is held: undefined when nothing in it is on the list (the server is not asked); else each command of
 * it on the list is asked about in turn, by its place in the line, and the first one held is the answer. A command the
 * server does not answer about (no answer, an error, an answer it cannot read) is held where heldUnanswered says.
 */
export async function holdCommand(
  command: string,
  input: HookStdin,
  deps: LeadHookDeps,
  onFallback?: (reason: string | undefined) => void,
): Promise<{ held: false } | { held: true; reason: string } | undefined> {
  let held: HeldFile;
  try {
    held = deps.held();
  } catch {
    // An unreadable file: as a broken one, P3's own list holds in any folder.
    held = { present: true, lines: [], folders: null };
  }
  const matches = heldActions(command, held.lines, input.cwd ?? null);
  if (matches.length === 0) return undefined;
  const first = matches.find((m) => heldUnanswered(held, m));
  onFallback?.(first === undefined ? undefined : unansweredReason(first.what));
  for (const match of matches) {
    let answer: unknown;
    try {
      answer = await deps.post(
        '/api/lead/hold',
        { sessionId: input.session_id ?? null, cwd: input.cwd ?? '', command, action: match.action, index: match.index, segment: match.segment, folder: match.folder },
        HOLD_POST_MS,
      );
    } catch {
      if (heldUnanswered(held, match)) return { held: true, reason: unansweredReason(match.what) };
      continue;
    }
    const a = answer as { say?: unknown; held?: unknown; text?: unknown } | undefined;
    if (a?.held === true && typeof a.text === 'string' && a.text.trim() !== '') return { held: true, reason: heldReason(a.text) };
    if (a?.say !== 'nothing' && heldUnanswered(held, match)) return { held: true, reason: unansweredReason(match.what) };
  }
  return { held: false };
}

/** The PreToolUse refusal Claude Code honours in every permission mode. */
export const preToolDeny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

/**
 * The hold hook (PreToolUse on Bash and PowerShell, started only for the watched families by HOOK_DEFS' `if` rules): what
 * it prints, or undefined to print nothing and let the command go on to the ordinary permission rules. Before it asks the
 * server it hands `deps.fallback` the refusal to print if it is cut off.
 */
export async function runHold(input: HookStdin, deps: LeadHookDeps | undefined): Promise<object | undefined> {
  const command = commandOf(input);
  if (command === undefined) return undefined;
  const d = deps ?? missingDeps;
  const result = await holdCommand(command, input, d, (reason) => d.fallback?.(reason === undefined ? undefined : preToolDeny(reason)));
  return result?.held ? preToolDeny(result.reason) : undefined;
}

/** Without a way to reach the server, a command on the list is held as if it did not answer. */
const missingDeps: LeadHookDeps = {
  post: () => Promise.reject(new Error('the hook has no way to reach InProgress')),
  held: () => ({ present: true, lines: [], folders: null }),
};
