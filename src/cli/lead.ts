import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LEAD_SWITCHES, type LeadBrief } from '../core/lead';
import { ApiClientError, createClient } from '../lib/client';
import { TASKS_NOT_RUNNING_HINT } from './tasks';

const WHO = '--as <name> --instructions <n>';
export const LEAD_USAGE = [
  'Usage:',
  '  inprogress lead rules <project> --as <name> [--bootstrap]',
  `  inprogress lead brief <project> ${WHO} [--mark] [--json]`,
  `  inprogress lead step <project> <step id> ${WHO}`,
  `  inprogress lead resource <project> <document id> ${WHO}`,
  `  inprogress lead answer <project> <ask id> --aiden <words> [--says <text>] ${WHO}`,
  `  inprogress lead decide <project> <ask id> --answer <text> --reason <text> [--kind product|technical] [--aiden <words>] ${WHO}`,
  `  inprogress lead undo <project> <decision> --aiden <words> [--reason <text>] ${WHO}`,
  `  inprogress lead set <project> quiet|voice-cap <value> [--aiden <words>] ${WHO}`,
  `  inprogress lead park <project> <step id> [--reason <text>] [--aiden <words>] ${WHO}`,
  `  inprogress lead drop <project> <step id> --reason <text> [--aiden <words>] ${WHO}`,
  `  inprogress lead promise <project> <text> --due <iso time> [--step <step id>] ${WHO}`,
  `  inprogress lead kept <project> <ask id> [--note <text>] ${WHO}`,
  `  inprogress lead intent <project> ${WHO}`,
  `  inprogress lead intent <project> <file | -> ${WHO}`,
  `  inprogress lead relay <project> <step id> <message | -> ${WHO}`,
  `  inprogress lead start <project> <step id> [--aiden <words>] ${WHO}`,
  `  inprogress lead allow <project> starts|landing|round --aiden <words> ${WHO}`,
  `  inprogress lead disallow <project> starts|landing|round [--aiden <words>] ${WHO}`,
  '  inprogress lead desk <project> [--json]',
  '  inprogress lead morning <project>',
  '  inprogress lead week <project>',
  '  inprogress lead counts <project> --since <iso time>',
  '  inprogress lead import-usage <file>',
].join('\n');

/** What a write command prints when the server did not answer in time: it may have been applied all the same. */
export const LEAD_TIMEOUT = 'InProgress did not answer in time. The command may still have been applied: read the brief before you try again.';
/** How long a relay waits for the server: longer than the server's own wait on the t3 CLI's send (60 s). */
export const RELAY_TIMEOUT_MS = 75_000;
/** What a relay prints when the server did not answer in time: the message may be in the thread already. */
export const RELAY_NO_ANSWER = 'InProgress did not answer. The message may have been delivered: do not send it again.';
/** What a start prints when the server did not answer in time: a thread may have been started already. */
export const START_NO_ANSWER = 'InProgress did not answer, and a thread may have been started. Do not run it again: read the brief and tell Aiden.';

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
  /** At least this many positional values, when fewer than `positionals` is allowed (default: `positionals`). */
  minPositionals?: number;
  flags: readonly string[];
  bools?: readonly string[];
  /** The command can be run without --instructions (the lead does not know the version until it has read the rules). */
  noInstructions?: boolean;
  /** The command needs neither --as nor --instructions: a read with no lead check. */
  noWho?: boolean;
}

const COMMANDS: Record<string, CommandSpec> = {
  rules: { positionals: 0, flags: [], bools: ['--bootstrap'], noInstructions: true },
  brief: { positionals: 0, flags: [], bools: ['--mark', '--json'] },
  step: { positionals: 1, flags: [] },
  resource: { positionals: 1, flags: [] },
  answer: { positionals: 1, flags: ['--aiden', '--says'] },
  decide: { positionals: 1, flags: ['--answer', '--reason', '--kind', '--aiden'] },
  undo: { positionals: 1, flags: ['--aiden', '--reason'] },
  set: { positionals: 2, flags: ['--aiden'] },
  park: { positionals: 1, flags: ['--reason', '--aiden'] },
  drop: { positionals: 1, flags: ['--reason', '--aiden'] },
  promise: { positionals: 1, flags: ['--due', '--step'] },
  kept: { positionals: 1, flags: ['--note'] },
  intent: { positionals: 1, minPositionals: 0, flags: [] },
  relay: { positionals: 2, flags: [] },
  start: { positionals: 1, flags: ['--aiden'] },
  allow: { positionals: 1, flags: ['--aiden'] },
  disallow: { positionals: 1, flags: ['--aiden'] },
  desk: { positionals: 0, flags: [], bools: ['--json'], noWho: true },
  morning: { positionals: 0, flags: [], noWho: true },
  week: { positionals: 0, flags: [], noWho: true },
  counts: { positionals: 0, flags: ['--since'], noWho: true },
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
  if (rest.length < (spec.minPositionals ?? spec.positionals)) return { error: 'Missing a value after <project>' };
  if (rest.length > spec.positionals) return { error: `Unexpected ${rest[spec.positionals]}` };
  if (as === undefined && !spec.noWho) return { error: 'Missing --as <name>' };
  if (instructions === undefined && !spec.noInstructions && !spec.noWho) return { error: 'Missing --instructions <n>' };
  return { project, positionals: rest, flags, bools, as: as ?? '', instructions: instructions ?? 0 };
}

/** An ask as the brief names it, `a7`, or as a bare number, `7`. */
const askId = (text: string): number | undefined => {
  const m = /^a?(\d+)$/i.exec(text.trim());
  return m && Number(m[1]) > 0 ? Number(m[1]) : undefined;
};
/** A decision as the brief names it, `d12`, or as a bare number, `12`. */
const decisionId = (text: string): number | undefined => {
  const m = /^d?(\d+)$/i.exec(text.trim());
  return m && Number(m[1]) > 0 ? Number(m[1]) : undefined;
};
/** A step as the brief names it, `#42`, or as a bare number, `42` (a shell reads an unquoted `#42` as a comment). */
const stepId = (text: string): number | undefined => {
  const m = /^#?(\d+)$/.exec(text.trim());
  return m && Number(m[1]) > 0 ? Number(m[1]) : undefined;
};

/** A document as `lead step` names it, `r42`, or as a bare number, `42`. */
const resourceId = (text: string): number | undefined => {
  const m = /^r?(\d+)$/i.exec(text.trim());
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
      fields.askId = id;
      fields.aidenWords = words;
      put('says', flag('--says'));
      return { fields };
    }
    case 'decide': {
      const id = askId(first);
      if (id === undefined) return { error: `${first} is not an ask: give it as a7 or 7` };
      const answer = needed('--answer');
      if ('error' in answer) return answer;
      const reason = needed('--reason');
      if ('error' in reason) return reason;
      // Technical unless named: sent only when given, so the body stays what an older server accepts.
      const kind = p.flags.get('--kind');
      if (kind !== undefined && kind !== 'product' && kind !== 'technical') return { error: `--kind is product or technical, not ${JSON.stringify(kind)}` };
      fields.askId = id;
      fields.answer = answer;
      fields.reason = reason;
      if (kind !== undefined) fields.kind = { text: kind };
      put('aidenWords', flag('--aiden'));
      return { fields };
    }
    case 'undo': {
      const id = decisionId(first);
      if (id === undefined) return { error: `${first} is not a decision: give it as d12 or 12` };
      const words = needed('--aiden');
      if ('error' in words) return words;
      fields.eventId = id;
      fields.aidenWords = words;
      put('reason', flag('--reason'));
      return { fields };
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
    case 'relay': {
      const id = stepId(first);
      if (id === undefined) return { error: `${first} is not a step: give it as #42 or 42` };
      return { fields: { stepId: id, message: valueOf(p.positionals[1])! } };
    }
    case 'start': {
      const id = stepId(first);
      if (id === undefined) return { error: `${first} is not a step: give it as #42 or 42` };
      fields.stepId = id;
      put('aidenWords', flag('--aiden'));
      return { fields };
    }
    case 'set': {
      fields.key = { text: first };
      fields.value = { text: p.positionals[1]! };
      put('aidenWords', flag('--aiden'));
      return { fields };
    }
    case 'allow':
    case 'disallow': {
      if (!(LEAD_SWITCHES as readonly string[]).includes(first)) return { error: `${first} is not a switch: give starts, landing or round` };
      fields.switch = { text: first };
      if (command === 'allow') {
        const words = needed('--aiden');
        if ('error' in words) return words;
        fields.aidenWords = words;
      } else put('aidenWords', flag('--aiden'));
      return { fields };
    }
    default:
      return { error: `Unknown command ${command}` };
  }
}

/**
 * `inprogress lead <command>`. `rules` prints the lead's rules (or with --bootstrap the three lines to paste) and needs no
 * --instructions. `brief` prints the server's text, or with --json the brief. `desk` prints the open desk items, or with
 * --json the items, and needs neither --as nor --instructions. `rules`, `brief`, `step`, `resource`, `desk` and `intent`
 * with no file are the reads: GETs that print the route's text. The nine commands (answer, decide, undo, park, drop, promise, kept, intent with a file or
 * `-`, relay) each post to their route and print its sentence. No command, an unknown one, or
 * arguments it cannot use print the usage and exit 1, before anything is read from stdin; a refusal from the server prints
 * its sentence and exits 1. The lead is how Aiden reaches a project, so unlike claim and ask a stopped server is started
 * first (`bringUp`), once the arguments are good; one that will not start prints why and exits 1. Without `bringUp`,
 * nothing answering is rethrown with a hint, except that a write command that timed out prints LEAD_TIMEOUT and exits 1. A
 * relay waits RELAY_TIMEOUT_MS, as the server waits on the t3 CLI, and when no answer comes back (its own timeout, or the server going away mid-send) it prints RELAY_NO_ANSWER.
 */
export async function runLead(args: string[], out: (line: string) => void, o: Conn, io: LeadIo = REAL_IO): Promise<number> {
  const usage = (why?: string): number => {
    if (why !== undefined) out(why);
    out(LEAD_USAGE);
    return 1;
  };
  const [command, ...rest] = args;
  // `import-usage` names a file, not a project: it asks the server to read stage 0's readings from it.
  if (command === 'import-usage') {
    if (rest.length !== 1) return usage('import-usage takes one file');
    const down = o.bringUp ? await o.bringUp() : null;
    if (down !== null) {
      out(down);
      return 1;
    }
    try {
      out((await createClient(o).post<{ text: string }>('/api/lead/usage/import', { file: resolve(rest[0]!) })).text);
      return 0;
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 0) throw new ApiClientError(0, err.message, TASKS_NOT_RUNNING_HINT, err.code);
      if (err instanceof ApiClientError) {
        out(err.message);
        return 1;
      }
      throw err;
    }
  }
  if (command === undefined || !Object.hasOwn(COMMANDS, command)) return usage();
  const p = parseArgs(rest, COMMANDS[command]);
  if ('error' in p) return usage(p.error);
  // The reads: brief, rules, step, resource, desk, and intent with no file. They are GETs and send nothing.
  const [first] = p.positionals;
  const reads = command === 'brief' || command === 'rules' || command === 'step' || command === 'resource' || command === 'desk' || command === 'morning' || command === 'week' || command === 'counts' || (command === 'intent' && first === undefined);
  const readId = command === 'step' ? stepId(first) : command === 'resource' ? resourceId(first) : undefined;
  if ((command === 'step' || command === 'resource') && readId === undefined) {
    return usage(command === 'step' ? `${first} is not a step: give it as #42 or 42` : `${first} is not a document: give it as r42 or 42`);
  }
  const body = reads ? undefined : draft(command, p);
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
      const res = await client.post<{ text: string }>(`${path}/${command}`, payload, command === 'relay' || command === 'start' ? { timeoutMs: RELAY_TIMEOUT_MS } : {});
      out(res.text);
      return 0;
    }
    const asked = `as=${encodeURIComponent(p.as)}&instructions=${p.instructions}`;
    if (command === 'step' || command === 'resource') {
      out((await client.get<{ text: string }>(`${path}/${command}/${readId}?${asked}`)).text);
      return 0;
    }
    if (command === 'intent') {
      out((await client.get<{ text: string }>(`${path}/intent?${asked}`)).text);
      return 0;
    }
    if (command === 'desk') {
      const desk = await client.get<{ items: unknown[]; text: string }>(`${path}/desk`);
      out(p.bools.has('--json') ? JSON.stringify(desk.items, null, 2) : desk.text);
      return 0;
    }
    if (command === 'morning' || command === 'week') {
      out((await client.get<{ text: string }>(`${path}/${command}`)).text);
      return 0;
    }
    if (command === 'counts') {
      const since = p.flags.get('--since');
      if (since === undefined || Number.isNaN(Date.parse(since))) return usage('counts needs --since <iso time>');
      out((await client.get<{ text: string }>(`${path}/counts?since=${encodeURIComponent(new Date(since).toISOString())}`)).text);
      return 0;
    }
    if (command === 'rules') {
      const rules = await client.get<{ text: string; bootstrap: string }>(`${path}/rules?as=${encodeURIComponent(p.as)}`);
      out(p.bools.has('--bootstrap') ? rules.bootstrap : rules.text);
      return 0;
    }
    const res = await client.get<{ brief: LeadBrief; text: string }>(`${path}/brief?as=${encodeURIComponent(p.as)}&instructions=${p.instructions}`);
    out(p.bools.has('--json') ? JSON.stringify(res.brief, null, 2) : res.text);
    // The look is marked after the brief is printed, by a write of its own: a failure there says so and exits 1. It
    // carries the brief's own time, so a step that lands between the two requests is still in the next brief.
    if (p.bools.has('--mark')) await client.post(`${path}/seen`, { as: p.as, instructions: p.instructions, at: res.brief.at });
    return 0;
  } catch (err) {
    // A write that timed out may have been carried out after all: say so, so the lead reads the brief before trying again,
    // and does not send a relay twice.
    // A relay whose request reached the server may have been sent even when the answer never came back (a timeout, or a
    // server restarted mid-send): only a refused connection means it never arrived.
    const noAnswer = err instanceof ApiClientError && err.status === 0 && (err.code === 'TIMEOUT' || ((command === 'relay' || command === 'start') && err.code !== 'ECONNREFUSED'));
    if (payload !== undefined && noAnswer) {
      out(command === 'relay' ? RELAY_NO_ANSWER : command === 'start' ? START_NO_ANSWER : LEAD_TIMEOUT);
      return 1;
    }
    if (err instanceof ApiClientError && err.status === 0) throw new ApiClientError(0, err.message, TASKS_NOT_RUNNING_HINT, err.code);
    if (err instanceof ApiClientError) {
      out(err.message);
      if (err.hint) out(err.hint);
      return 1;
    }
    throw err;
  }
}
