import type { LeadBrief } from '../core/lead';
import { ApiClientError, createClient } from '../lib/client';
import { TASKS_NOT_RUNNING_HINT } from './tasks';

export const LEAD_USAGE = 'Usage: inprogress lead brief <project> --as <name> --instructions <n> [--mark] [--json]';

interface Conn {
  baseUrl: string;
  token?: string;
  /** Brings the server up when it is down: null once it answers, or the line to print when it would not start. */
  bringUp?: () => Promise<string | null>;
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
 * sentence and exits 1. The lead is how Aiden reaches a project, so unlike claim and ask a stopped server is started
 * first (`bringUp`), once the arguments are good; one that will not start prints why and exits 1. Without `bringUp`,
 * nothing answering is rethrown with a hint.
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
  const down = o.bringUp ? await o.bringUp() : null;
  if (down !== null) {
    out(down);
    return 1;
  }
  const client = createClient(o);
  const path = `/api/lead/${encodeURIComponent(parsed.project)}`;
  try {
    const res = await client.get<{ brief: LeadBrief; text: string }>(`${path}/brief?as=${encodeURIComponent(parsed.as)}&instructions=${parsed.instructions}`);
    out(parsed.json ? JSON.stringify(res.brief, null, 2) : res.text);
    // The look is marked after the brief is printed, by a write of its own: a failure there says so and exits 1. It
    // carries the brief's own time, so a step that lands between the two requests is still in the next brief.
    if (parsed.mark) await client.post(`${path}/seen`, { as: parsed.as, instructions: parsed.instructions, at: res.brief.at });
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
