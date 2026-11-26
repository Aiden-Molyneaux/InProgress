// A recording stand-in for the t3 CLI in the scenes harness (scripts/lead-scenes/run.mjs). It keeps a JSON world of threads in
// <SCENES_WORK>/t3.json and appends every call, with its time and the text it was given on stdin, to <SCENES_WORK>/t3-calls.jsonl.
//   thread list --project <p> --json   the threads of the world
//   thread show <id> --json            one thread and its messages
//   thread start <project> - [--title T] ... --json   a new thread; its first message is stdin
//   thread send <id> - --json          appends stdin to the thread
// The scenes' own sessions are added to the world by the harness. It reaches nothing outside <SCENES_WORK>.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const work = process.env.SCENES_WORK;
if (!work) {
  process.stderr.write('SCENES_WORK is not set: the recorder keeps its world there\n');
  process.exit(2);
}
const worldFile = join(work, 't3.json');
const callsFile = join(work, 't3-calls.jsonl');
const args = process.argv.slice(2);
const now = () => new Date().toISOString();

let stdin = '';
if ((args[1] === 'start' || args[1] === 'send') && args.includes('-')) {
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    // No stdin was given (a closed pipe): the call is recorded with no text.
  }
}
appendFileSync(callsFile, `${JSON.stringify({ at: now(), args, stdin })}\n`);

const world = existsSync(worldFile) ? JSON.parse(readFileSync(worldFile, 'utf8')) : { threads: [], next: 1 };
const save = () => writeFileSync(worldFile, `${JSON.stringify(world, null, 2)}\n`);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const view = (t) => ({
  threadId: t.threadId,
  projectId: t.projectId ?? 'scenes',
  title: t.title ?? '',
  link: `t3://thread/${t.threadId}`,
  status: t.status ?? 'idle',
  runtimeMode: 'full-access',
  settled: true,
  archived: false,
  pendingRequestCount: 0,
  updatedAt: t.messages.at(-1)?.createdAt ?? t.createdAt,
  createdAt: t.createdAt,
  createdBy: 'scenes',
  creationSource: 'scenes',
});
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (text) => {
  process.stderr.write(`${text}\n`);
  process.exit(1);
};

if (args[0] !== 'thread') fail(`the scenes' recorder does not know ${args[0] ?? '(nothing)'}`);
if (args[1] === 'list') out(world.threads.map(view));
else if (args[1] === 'show') {
  const t = world.threads.find((x) => x.threadId === args[2]);
  if (!t) fail(`no such thread: ${args[2]}`);
  out({ thread: view(t), messages: t.messages });
} else if (args[1] === 'start') {
  const threadId = `scenes-thread-${world.next++}`;
  const at = now();
  world.threads.push({ threadId, projectId: args[2], title: flag('--title') ?? '', createdAt: at, started: true, messages: [{ role: 'user', text: stdin, createdAt: at }] });
  save();
  out({ threadId });
} else if (args[1] === 'send') {
  const t = world.threads.find((x) => x.threadId === args[2]);
  if (!t) fail(`no such thread: ${args[2]}`);
  t.messages.push({ role: 'user', text: stdin, createdAt: now() });
  save();
  out({ ok: true });
} else fail(`the scenes' recorder does not know thread ${args[1] ?? ''}`);
