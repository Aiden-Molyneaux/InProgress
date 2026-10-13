import { createClient } from '../lib/client';
import { isServerUp } from '../lib/ensure-server';

export const DIGEST_USAGE = 'Usage: inprogress digest <project> [--since <iso time>]';
export const USAGE_USAGE = 'Usage: inprogress usage <project> [--days <n>]';

/** `<project> [<flag> <value>]`: the project is the one argument that is not a flag or a flag's value. */
function parseReport(args: string[], flag: string): { project: string; value?: string } | { error: string } {
  let project: string | undefined;
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      const next = args[i + 1]?.trim();
      if (!next || next.startsWith('--')) return { error: `${flag} needs a value` };
      value = next;
      i++;
    } else if (arg.startsWith('--')) return { error: `Unknown flag ${arg}` };
    else if (project !== undefined) return { error: 'Name one project' };
    else project = arg;
  }
  return project ? { project, ...(value === undefined ? {} : { value }) } : { error: 'Missing <project>' };
}

async function run(path: string, out: (line: string) => void, baseUrl: string, probeMs: number): Promise<string | undefined> {
  if (!(await isServerUp(baseUrl, probeMs))) {
    out('InProgress is not running.');
    return undefined;
  }
  return (await createClient({ baseUrl }).get<{ text: string }>(path)).text;
}

/** `inprogress digest <project> [--since <iso>]`: prints the route's text. A bad time is refused here, before the server is asked. */
export async function runDigest(args: string[], out: (line: string) => void, o: { baseUrl: string; probeMs: number }): Promise<number> {
  const parsed = parseReport(args, '--since');
  if ('error' in parsed) {
    out(parsed.error);
    out(DIGEST_USAGE);
    return 1;
  }
  if (parsed.value !== undefined && Number.isNaN(Date.parse(parsed.value))) {
    out(`Not a time: ${parsed.value}`);
    out(DIGEST_USAGE);
    return 1;
  }
  const query = parsed.value === undefined ? '' : `?since=${encodeURIComponent(new Date(Date.parse(parsed.value)).toISOString())}`;
  const text = await run(`/api/projects/${encodeURIComponent(parsed.project)}/digest${query}`, out, o.baseUrl, o.probeMs);
  if (text === undefined) return 1;
  out(text);
  return 0;
}

/** `inprogress usage <project> [--days <n>]`: prints the route's table. */
export async function runUsage(args: string[], out: (line: string) => void, o: { baseUrl: string; probeMs: number }): Promise<number> {
  const parsed = parseReport(args, '--days');
  if ('error' in parsed || (parsed.value !== undefined && !/^\d+$/.test(parsed.value))) {
    out('error' in parsed ? parsed.error : `--days needs a whole number, not ${parsed.value}`);
    out(USAGE_USAGE);
    return 1;
  }
  const text = await run(`/api/projects/${encodeURIComponent(parsed.project)}/usage${parsed.value === undefined ? '' : `?days=${parsed.value}`}`, out, o.baseUrl, o.probeMs);
  if (text === undefined) return 1;
  out(text);
  return 0;
}
