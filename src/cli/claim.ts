import type { Ask, AskKind } from '../core/types';
import { askTag } from '../core/types';
import { ApiClientError, createClient } from '../lib/client';
import { raiseNotes, type RaiseReply } from '../lib/ask-notes';
import { TASKS_NOT_RUNNING_HINT, TASKS_TIMEOUT_HINT } from './tasks';

export const CLAIM_USAGE = 'Usage: inprogress claim <step id> --session <session id>';
export const ORCHESTRATE_USAGE = 'Usage: inprogress orchestrate --session <session id> [--status]';
export const ASK_USAGE = 'Usage: inprogress ask <step id> --session <session id> --question|--permission|--review "<text>"';

interface Conn {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

const ASK_FLAGS = new Map<string, AskKind>([
  ['--question', 'question'],
  ['--permission', 'permission'],
  ['--review', 'review'],
]);

/** A step id as typed: bare, or with the `#` an unquoted shell would have cut off. */
const stepId = (text: string): number | undefined => {
  const m = /^#?([1-9]\d*)$/.exec(text.trim());
  return m ? Number(m[1]) : undefined;
};

/** Walks `args`, handing each flag to `onFlag` (which returns how many extra arguments it used, or an error), and collects the rest. */
function walk(args: string[], onFlag: (flag: string, next: string | undefined) => number | { error: string } | undefined): { rest: string[] } | { error: string } {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const used = onFlag(arg, args[i + 1]);
      if (used === undefined) return { error: `Unknown flag ${arg}` };
      if (typeof used === 'object') return used;
      i += used;
    } else rest.push(arg);
  }
  return { rest };
}

export function parseClaimArgs(args: string[]): { session: string; nodeId: number } | { error: string } {
  let session: string | undefined;
  const walked = walk(args, (flag, next) => {
    if (flag !== '--session') return undefined;
    if (!next?.trim() || next.startsWith('--')) return { error: '--session needs the session id' };
    if (session !== undefined) return { error: '--session is given twice' };
    session = next.trim();
    return 1;
  });
  if ('error' in walked) return walked;
  if (walked.rest.length !== 1) return { error: walked.rest.length ? 'Name one step' : 'Missing the step id' };
  const nodeId = stepId(walked.rest[0]);
  if (nodeId === undefined) return { error: `Not a step id: ${walked.rest[0]}` };
  if (session === undefined) return { error: 'Missing --session <session id>' };
  return { session, nodeId };
}

export function parseOrchestrateArgs(args: string[]): { session: string; status: boolean } | { error: string } {
  let session: string | undefined;
  let status = false;
  const walked = walk(args, (flag, next) => {
    if (flag === '--status') {
      status = true;
      return 0;
    }
    if (flag !== '--session') return undefined;
    if (!next?.trim() || next.startsWith('--')) return { error: '--session needs the session id' };
    if (session !== undefined) return { error: '--session is given twice' };
    session = next.trim();
    return 1;
  });
  if ('error' in walked) return walked;
  if (walked.rest.length) return { error: `Unexpected argument ${walked.rest[0]}` };
  if (session === undefined) return { error: 'Missing --session <session id>' };
  return { session, status };
}

export function parseAskArgs(args: string[]): { session: string; nodeId: number; kind: AskKind; text: string } | { error: string } {
  let session: string | undefined;
  let kind: AskKind | undefined;
  let text: string | undefined;
  const walked = walk(args, (flag, next) => {
    if (flag === '--session') {
      if (!next?.trim() || next.startsWith('--')) return { error: '--session needs the session id' };
      if (session !== undefined) return { error: '--session is given twice' };
      session = next.trim();
      return 1;
    }
    const k = ASK_FLAGS.get(flag);
    if (!k) return undefined;
    if (kind !== undefined) return { error: 'Give exactly one of --question, --permission, --review' };
    if (!next?.trim() || next.startsWith('--')) return { error: `${flag} needs the text` };
    kind = k;
    text = next.trim();
    return 1;
  });
  if ('error' in walked) return walked;
  if (walked.rest.length !== 1) return { error: walked.rest.length ? 'Name one step' : 'Missing the step id' };
  const nodeId = stepId(walked.rest[0]);
  if (nodeId === undefined) return { error: `Not a step id: ${walked.rest[0]}` };
  if (session === undefined) return { error: 'Missing --session <session id>' };
  if (kind === undefined || text === undefined) return { error: 'Give exactly one of --question, --permission, --review' };
  return { session, nodeId, kind, text };
}

/**
 * These commands never start the server (as tasks does). A refusal (status 400 and the like) prints its error and hint
 * and exits 1; nothing answering is rethrown with the hint a session can act on, for main.ts to print.
 */
async function call<T>(out: (line: string) => void, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 0) {
      throw new ApiClientError(0, err.message, err.code === 'TIMEOUT' ? TASKS_TIMEOUT_HINT : TASKS_NOT_RUNNING_HINT, err.code);
    }
    if (err instanceof ApiClientError) {
      out(err.message);
      if (err.hint) out(err.hint);
      return undefined;
    }
    throw err;
  }
}

/** `inprogress claim <id> --session <sid>`: prints the notes, then the step block. */
export async function runClaim(args: string[], out: (line: string) => void, o: Conn): Promise<number> {
  const parsed = parseClaimArgs(args);
  if ('error' in parsed) {
    out(parsed.error);
    out(CLAIM_USAGE);
    return 1;
  }
  const res = await call(out, () =>
    createClient(o).post<{ notes: string[]; block: string[] }>(`/api/sessions/${encodeURIComponent(parsed.session)}/claim`, { nodeId: parsed.nodeId }, { actor: `session:${parsed.session}` }),
  );
  if (!res) return 1;
  for (const line of [...res.notes, ...res.block]) out(line);
  return 0;
}

/** `inprogress orchestrate --session <sid> [--status]`: prints the opening. */
export async function runOrchestrate(args: string[], out: (line: string) => void, o: Conn): Promise<number> {
  const parsed = parseOrchestrateArgs(args);
  if ('error' in parsed) {
    out(parsed.error);
    out(ORCHESTRATE_USAGE);
    return 1;
  }
  const res = await call(out, () =>
    createClient(o).post<{ opening: string }>(`/api/sessions/${encodeURIComponent(parsed.session)}/orchestrate`, { status: parsed.status }, { actor: `session:${parsed.session}` }),
  );
  if (!res) return 1;
  out(res.opening);
  return 0;
}

/** `inprogress ask <id> --session <sid> --question|--permission|--review "<text>"`: prints `a7 raised on #42`, then any notes. */
export async function runAsk(args: string[], out: (line: string) => void, o: Conn): Promise<number> {
  const parsed = parseAskArgs(args);
  if ('error' in parsed) {
    out(parsed.error);
    out(ASK_USAGE);
    return 1;
  }
  const res = await call(out, () =>
    createClient(o).post<RaiseReply & Ask>(
      `/api/nodes/${parsed.nodeId}/asks`,
      { kind: parsed.kind, text: parsed.text, sessionId: parsed.session },
      { actor: `session:${parsed.session}` },
    ),
  );
  if (!res) return 1;
  out(`${askTag(res.id)} raised on #${res.nodeId}`);
  for (const note of raiseNotes(res, parsed.session)) out(note);
  return 0;
}
