import { LANDING_ACTIONS } from '../core/landing';
import type { NodeDetail } from '../core/types';
import { ApiClientError, createClient } from '../lib/client';
import { TASKS_NOT_RUNNING_HINT } from './tasks';

export const LANDING_USAGE = `Usage: inprogress landing <step id> --action ${LANDING_ACTIONS.join('|')} [--branch <branch>]`;
/** The exit code of a change that is held for Aiden: 0 is clear, 1 is a refusal or a bad command. */
export const LANDING_HELD = 3;

interface Conn {
  baseUrl: string;
  token?: string;
}

/**
 * `inprogress landing <step> --action <action> [--branch <b>]`, run from the session's folder (a git checkout): prints
 * the server's verdict, `Clear to land` or `hold: this is Aiden's (<why>)`, and exits 0 when clear, 3 when held, 1 when the
 * server refuses (an unknown step, a folder that is not a git checkout) or the command is wrong. It never starts the server.
 */
export async function runLanding(args: string[], out: (line: string) => void, o: Conn, folder: string = process.cwd()): Promise<number> {
  const usage = (why: string): number => {
    out(why);
    out(LANDING_USAGE);
    return 1;
  };
  let action: string | undefined;
  let branch: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--action' || arg === '--branch') {
      const next = args[i + 1];
      if (next === undefined || !next.trim() || next.startsWith('--')) return usage(`${arg} needs a value`);
      i++;
      if (arg === '--action') action = next.trim();
      else branch = next.trim();
    } else if (arg.startsWith('--')) return usage(`Unknown flag ${arg}`);
    else rest.push(arg);
  }
  const m = /^#?([1-9]\d*)$/.exec((rest[0] ?? '').trim());
  if (rest.length === 0) return usage('Missing <step id>');
  if (rest.length > 1) return usage(`Unexpected ${rest[1]}`);
  if (!m) return usage(`${rest[0]} is not a step: give it as #42 or 42`);
  if (action === undefined) return usage('Missing --action');
  if (!(LANDING_ACTIONS as readonly string[]).includes(action)) return usage(`${action} is not an action: give ${LANDING_ACTIONS.join(', ')}`);
  const stepId = Number(m[1]);
  try {
    const client = createClient(o);
    // The step names its project: the route is the project's.
    const { node } = await client.get<NodeDetail>(`/api/nodes/${stepId}`);
    const res = await client.post<{ clear: boolean; text: string }>(`/api/lead/${node.projectId}/landing`, { stepId, action, folder, ...(branch === undefined ? {} : { branch }) });
    out(res.text);
    return res.clear ? 0 : LANDING_HELD;
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
