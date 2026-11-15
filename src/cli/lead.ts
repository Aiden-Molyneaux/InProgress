import { readFileSync } from 'node:fs';
import type { LeadBrief } from '../core/lead';
import { ApiClientError, createClient } from '../lib/client';
import { TASKS_NOT_RUNNING_HINT } from './tasks';

const WHO = '--as <name> --instructions <n>';
export const LEAD_USAGE = [
  'Usage:',
  `  inprogress lead brief <project> ${WHO} [--mark] [--json]`,
  `  inprogress lead answer <project> <ask id> --aiden <words> ${WHO}`,
  `  inprogress lead park <project> <step id> [--reason <text>] [--aiden <words>] ${WHO}`,
  `  inprogress lead drop <project> <step id> --reason <text> [--aiden <words>] ${WHO}`,
  `  inprogress lead promise <project> <text> --due <iso time> [--step <step id>] ${WHO}`,
  `  inprogress lead kept <project> <ask id> [--note <text>] ${WHO}`,
  `  inprogress lead intent <project> <file | -> ${WHO}`,
].join('\n');

interface Conn {
  baseUrl: string;
  token?: string;
  /** Brings the server up when it is down: null once it answers, or the line to print when it would not start. */
  bringUp?: () => Promise<string | null>;
}

/** Where a command reads a value given as `-`, and an intent file. A test passes its own. */
export interface LeadIo {
  stdin: () => Promise<string>;
  readFile: (path: string) => string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

const REAL_IO: LeadIo = { stdin: readStdin, readFile: (path) => readFileSync(path, 'utf8') };

/** What each command takes after its project: how many positional values, its flags with a value, and its bare flags. */
interface CommandSpec {
  positionals: number;
  flags: readonly string[];
  bools?: readonly string[];
}

const COMMANDS: Record<string, CommandSpec> = {
  brief: { positionals: 0, flags: [], bools: ['--mark', '--json'] },
  answer: { positionals: 1, flags: ['--aiden'] },
  park: { positionals: 1, flags: ['--reason', '--aiden'] },
  drop: { positionals: 1, flags: ['--reason', '--aiden'] },
  promise: { positionals: 1, flags: ['--due', '--step'] },
  kept: { positionals: 1, flags: ['--note'] },
  intent: { positionals: 1, flags: [] },
};

interface Parsed {
  project: string;
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
  as: string;
  instructions: number;
}

/** `<project> [positionals] [flags] --as <name> --instructions <n>`, parsed as `spec` says; or what is wrong with it. */
function parseArgs(args: string[], spec: CommandSpec): Parsed | { error: string } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  let as: string | undefined;
  let instructions: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (spec.bools?.includes(arg)) bools.add(arg);
    else if (arg === '--as' || arg === '--instructions' || spec.flags.includes(arg)) {
      const next = args[i + 1];
      if (next === undefined || !next.trim() || next.startsWith('--')) return { error: `${arg} needs a value` };
      i++;
      if (arg === '--as') as = next.trim();
      else if (arg === '--instructions') {
        if (!/^\d+$/.test(next.trim())) return { error: `--instructions needs a whole number, not ${next}` };
        instructions = Number(next.trim());
      } else flags.set(arg, next);
    } else if (arg.startsWith('--')) return { error: `Unknown flag ${arg}` };
    else positionals.push(arg);
  }
  const [project, ...rest] = positionals;
  if (project === undefined) return { error: 'Missing <project>' };
  if (rest.length < spec.positionals) return { error: 'Missing a value after <project>' };
  if (rest.length > spec.positionals) return { error: `Unexpected ${rest[spec.positionals]}` };
  if (as === undefined) return { error: 'Missing --as <name>' };
  if (instructions === undefined) return { error: 'Missing --instructions <n>' };
  return { project, positionals: rest, flags, bools, as, instructions };
}

/** An ask as the brief names it, `a7`, or as a bare number, `7`. */
const askId = (text: string): number | undefined => {
  const m = /^a?(\d+)$/i.exec(text.trim());
  return m && Number(m[1]) > 0 ? Number(m[1]) : undefined;
};
/** A step as the brief names it, `#42`, or as a bare number, `42` (a shell reads an unquoted `#42` as a comment). */
const stepId = (text: string): number | undefined => {
  const m = /^#?(\d+)$/.exec(text.trim());
  return m && Number(m[1]) > 0 ? Number(m[1]) : undefined;
};

/** A value to send: as given, or read from stdin when it is `-`. A command takes at most one `-`. */
type Value = { text: string } | { stdin: true };
const valueOf = (text: string | undefined): Value | undefined => (text === undefined ? undefined : text === '-' ? { stdin: true } : { text });

/**
 * A command's body, with `-` values still to read: the fields as the route takes them, each a Value or a plain number; or
 * what is wrong with the arguments. `file` is the intent file to read, when it is not `-`.
 */
type Draft = { fields: Record<string, Value | number>; file?: string } | { error: string };

function draft(command: string, p: Parsed): Draft {
  const [first] = p.positionals;
  const flag = (name: string) => valueOf(p.flags.get(name));
  const needed = (name: string): Value | { error: string } => flag(name) ?? { error: `Missing ${name}` };
  const fields: Record<string, Value | number> = {};
  const put = (key: string, value: Value | undefined) => {
    if (value !== undefined) fields[key] = value;
  };
  switch (command) {
    case 'answer': {
      const id = askId(first);
      if (id === undefined) return { error: `${first} is not an ask: give it as a7 or 7` };
      const words = needed('--aiden');
      if ('error' in words) return words;
      return { fields: { askId: id, aidenWords: words } };
    }
    case 'park':
    case 'drop': {
      const id = stepId(first);
      if (id === undefined) return { error: `${first} is not a step: give it as #42 or 42` };
      fields.stepId = id;
      if (command === 'drop') {
        const reason = needed('--reason');
        if ('error' in reason) return reason;
        fields.reason = reason;
      } else put('reason', flag('--reason'));
      put('aidenWords', flag('--aiden'));
      return { fields };
    }
    case 'promise': {
      const due = p.flags.get('--due');
      if (due === undefined) return { error: 'Missing --due' };
      if (first === '-') return { error: 'A promise takes its text as an argument, not from stdin' };
      const step = p.flags.get('--step');
      const id = step === undefined ? undefined : stepId(step);
      if (step !== undefined && id === undefined) return { error: `${step} is not a step: give it as #42 or 42` };
      return { fields: { text: { text: first }, dueAt: { text: due }, ...(id === undefined ? {} : { stepId: id }) } };
    }
    case 'kept': {
      const id = askId(first);
      if (id === undefined) return { error: `${first} is not an ask: give it as a7 or 7` };
      fields.askId = id;
      put('note', flag('--note'));
      return { fields };
    }
    case 'intent':
      return first === '-' ? { fields: { intent: { stdin: true } } } : { fields: {}, file: first };
    default:
      return { error: `Unknown command ${command}` };
  }
}

/**
 * `inprogress lead <command>`. `brief` prints the server's text, or with --json the brief; the six commands (answer, park,
 * drop, promise, kept, intent) each post to their route and print its sentence. No command, an unknown one, or arguments it
 * cannot use print the usage and exit 1, before anything is read from stdin; a refusal from the server prints its sentence
 * and exits 1. The lead is how Aiden reaches a project, so unlike claim and ask a stopped server is started first
 * (`bringUp`), once the arguments are good; one that will not start prints why and exits 1. Without `bringUp`, nothing
 * answering is rethrown with a hint.
 */
export async function runLead(args: string[], out: (line: string) => void, o: Conn, io: LeadIo = REAL_IO): Promise<number> {
  const usage = (why?: string): number => {
    if (why !== undefined) out(why);
    out(LEAD_USAGE);
    return 1;
  };
  const [command, ...rest] = args;
  if (command === undefined || !Object.hasOwn(COMMANDS, command)) return usage();
  const p = parseArgs(rest, COMMANDS[command]);
  if ('error' in p) return usage(p.error);
  const body = command === 'brief' ? undefined : draft(command, p);
  if (body !== undefined && 'error' in body) return usage(body.error);
  if (body !== undefined && Object.values(body.fields).filter((v) => typeof v === 'object' && 'stdin' in v).length > 1) {
    return usage('Only one value can be read from stdin (-)');
  }

  // The values given as `-`, and the intent file, are read before the server is asked anything.
  let payload: Record<string, unknown> | undefined;
  if (body !== undefined) {
    payload = { as: p.as, instructions: p.instructions };
    for (const [key, value] of Object.entries(body.fields)) payload[key] = typeof value === 'number' ? value : 'stdin' in value ? await io.stdin() : value.text;
    if (body.file !== undefined) {
      try {
        payload.intent = io.readFile(body.file);
      } catch (err) {
        out(`Could not read ${body.file}: ${(err as Error).message}`);
        return 1;
      }
    }
  }

  const down = o.bringUp ? await o.bringUp() : null;
  if (down !== null) {
    out(down);
    return 1;
  }
  const client = createClient(o);
  const path = `/api/lead/${encodeURIComponent(p.project)}`;
  try {
    if (payload !== undefined) {
      const res = await client.post<{ text: string }>(`${path}/${command}`, payload);
      out(res.text);
      return 0;
    }
    const res = await client.get<{ brief: LeadBrief; text: string }>(`${path}/brief?as=${encodeURIComponent(p.as)}&instructions=${p.instructions}`);
    out(p.bools.has('--json') ? JSON.stringify(res.brief, null, 2) : res.text);
    // The look is marked after the brief is printed, by a write of its own: a failure there says so and exits 1. It
    // carries the brief's own time, so a step that lands between the two requests is still in the next brief.
    if (p.bools.has('--mark')) await client.post(`${path}/seen`, { as: p.as, instructions: p.instructions, at: res.brief.at });
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
