import type { LeadBrief } from '../core/lead';
import { ApiClientError, createClient } from '../lib/client';
import { TASKS_NOT_RUNNING_HINT } from './tasks';

export const LEAD_USAGE = 'Usage: inprogress lead brief <project> --as <name> --instructions <n> [--mark] [--json]';

interface Conn {
  baseUrl: string;
  token?: string;
}

/** `brief <project> --as <name> --instructions <n> [--mark] [--json]`, parsed; or what is wrong with it. */
function parseBriefArgs(args: string[]): { project: string; as: string; instructions: number; mark: boolean; json: boolean } | { error: string } {
  let project: string | undefined;
  let as: string | undefined;
  let instructions: number | undefined;
  let mark = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mark') mark = true;
    else if (arg === '--json') json = true;
    else if (arg === '--as' || arg === '--instructions') {
      const next = args[i + 1]?.trim();
      if (!next || next.startsWith('--')) return { error: `${arg} needs a value` };
      i++;
      if (arg === '--as') as = next;
      else if (/^\d+$/.test(next)) instructions = Number(next);
      else return { error: `--instructions needs a whole number, not ${next}` };
    } else if (arg.startsWith('--')) return { error: `Unknown flag ${arg}` };
    else if (project !== undefined) return { error: 'Name one project' };
    else project = arg;
  }
  if (project === undefined) return { error: 'Missing <project>' };
  if (as === undefined) return { error: 'Missing --as <name>' };
  if (instructions === undefined) return { error: 'Missing --instructions <n>' };
  return { project, as, instructions, mark, json };
}

/**
 * `inprogress lead <subcommand>`. Only `brief` exists so far: it prints the server's text, or with --json the brief. Any
 * other subcommand, or a missing --as or --instructions, prints the usage and exits 1; a refusal from the server prints its
 * sentence and exits 1. Like claim and ask, it never starts the server: nothing answering is rethrown with a hint.
 */
export async function runLead(args: string[], out: (line: string) => void, o: Conn): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'brief') {
    out(LEAD_USAGE);
    return 1;
  }
  const parsed = parseBriefArgs(rest);
  if ('error' in parsed) {
    out(parsed.error);
    out(LEAD_USAGE);
    return 1;
  }
  const query = `as=${encodeURIComponent(parsed.as)}&instructions=${parsed.instructions}${parsed.mark ? '&mark=1' : ''}`;
  try {
    const res = await createClient(o).get<{ brief: LeadBrief; text: string }>(`/api/lead/${encodeURIComponent(parsed.project)}/brief?${query}`);
    out(parsed.json ? JSON.stringify(res.brief, null, 2) : res.text);
    return 0;
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 0) throw new ApiClientError(0, err.message, TASKS_NOT_RUNNING_HINT, err.code);
    if (err instanceof ApiClientError) {
      out(err.message);
      if (err.hint) out(err.hint);
      return 1;
    }
    throw err;
  }
}
