import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Project } from '../../core/types';
import { write, type Ctx, type RecordEvent } from '../db/tx';
import { leadFolders } from '../lead';
import { getDeskItem, leadOfItem, openItemsInLane, type DeskItem, type DeskLane } from '../repo/desk';
import { bringNext } from '../repo/deskBring';
import { onDeskItem } from '../repo/deskProducers';
import { answeredTurns, applyTurn, expiredLeases, failAnsweredTurn, failTurn, leaseItem, RUNNER_FAULT_WHY, saveAnswer, type LeadTurn, type TurnEffect, type TurnFields } from '../repo/leadTurns';
import { getProjectById } from '../repo/projects';
import { isLiveWithRound, liveProjectsWithRound } from '../repo/switches';
import { addReading, type AddReadingInput } from '../repo/usageReadings';
import { deskSystemPrompt, deskUserMessage } from './prompt';
import { parseVerdict } from './verdict';

/** The model a desk turn runs on: Opus 5.5. */
export const LEAD_MODEL = 'claude-opus-5-5';
/** How long a turn's lease runs. */
export const LEASE_MS = 6 * 60 * 1000;
/** A turn still running this long before its lease ends is stopped, so it never outlives the lease. */
export const ABORT_BEFORE_LEASE_END_MS = 30 * 1000;
/** How often the runner recovers and looks at every desk whose round is on. */
export const TICK_MS = 30 * 1000;
/** Reflex turns at once per project, in one runner. Old asks have one lane of their own beside them. */
export const REFLEX_PER_PROJECT = 2;
/** The throw of an answered turn's apply that fails the turn, rather than leave it for the next tick. */
export const APPLY_THROWS_FAIL = 2;
/** After a runner fault (claude would not run, or ended in error), no new lease for the project for this long; then one try. */
export const FAULT_BACKOFF_MS = 5 * 60 * 1000;
/** How long stop() waits for its aborted runs to end. */
export const STOP_WAIT_MS = 2000;
/** How long a run may go on after its result line before it is killed. */
export const AFTER_RESULT_KILL_MS = 5000;
/** After an abort or a kill, how long a run has to end before it is settled anyway: the kill itself may have failed. */
export const KILL_GRACE_MS = 10_000;
/** The most a turn's stream may run to in tool calls and replies. */
const MAX_TURNS = 14;
/** How much of a failed run's stderr its failure keeps. */
const STDERR_TAIL_CHARS = 2000;

/** The environment the lead's tool server gets: the server's own home and port, the lead's name, the project's repo. */
export interface ToolsEnv {
  INPROGRESS_HOME: string;
  INPROGRESS_PORT: string;
  INPROGRESS_LEAD_AS: string;
  /** The folder the git facts are read in; absent when the project has no folder. */
  INPROGRESS_LEAD_REPO?: string;
}

/** One desk turn to run. */
export interface TurnInput {
  /** The turn's id: the run's own files are named by it. */
  turnId: number;
  slug: string;
  item: DeskItem;
  systemPrompt: string;
  userMessage: string;
  model: string;
  toolsEnv: ToolsEnv;
}

/** What a turn ran to. */
export interface TurnOutput {
  /** The final result text: the four lines, if the turn kept to them. */
  text: string;
  costUsd: number | null;
  durationMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** The names of the tools the turn was refused. */
  refusedTools: string[];
  /** Each rate_limit_info as streamed. */
  rateLimits: unknown[];
  model: string;
}

/** What a run that did not answer still read: its rate limits always, its costs when a result line came. */
export type PartialOutput = Partial<Omit<TurnOutput, 'text' | 'rateLimits'>> & { rateLimits: unknown[] };

/**
 * A run that did not answer, with what it read. `runnerFault`: the fault is the runner's, not the item's (claude would not
 * start, ended with no result line, or ended in error such as not logged in or a usage limit): the item is not counted
 * toward behind, and the runner backs off.
 */
export class TurnRunError extends Error {
  constructor(
    message: string,
    readonly partial: PartialOutput,
    readonly runnerFault: boolean,
  ) {
    super(message);
  }
}

/** A way to run a desk turn: headless (`claude -p`), or a message in the lead's thread (task 12). */
export interface TurnWay {
  name: 'headless' | 'thread';
  run(input: TurnInput, signal: AbortSignal): Promise<TurnOutput>;
}

/** dist/lead/tools.js, resolved from the server's bundle (dist/server/main.js) as ensure-server.ts resolves the server's. */
export function leadToolsEntry(): string {
  return fileURLToPath(new URL('../lead/tools.js', import.meta.url));
}

/** The session variables P1's turn.sh unset, by name. */
const SESSION_VARS = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
]);

/**
 * The server's environment without the variables of the Claude session or T3 Code thread that may have started it: P1's
 * list, any name starting CLAUDE_CODE_SESSION or CLAUDE_CODE_MESSAGING, and T3CODE_*. A user's own settings
 * (CLAUDE_CODE_GIT_BASH_PATH, CLAUDE_CODE_OAUTH_TOKEN) pass through. Names are compared in capitals, as Windows treats them.
 */
export function turnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const u = name.toUpperCase();
    if (SESSION_VARS.has(u) || u.startsWith('CLAUDE_CODE_SESSION') || u.startsWith('CLAUDE_CODE_MESSAGING') || u.startsWith('T3CODE_')) continue;
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** The `claude -p` arguments of a headless desk turn. */
export function headlessArgs(model: string, promptFile: string, toolsFile: string): string[] {
  return [
    '-p', '--model', model, '--system-prompt-file', promptFile, '--setting-sources', 'project', '--strict-mcp-config',
    '--mcp-config', toolsFile, '--tools', '', '--allowedTools', 'mcp__inprogress-lead', '--output-format', 'stream-json',
    '--verbose', '--max-turns', String(MAX_TURNS), '--no-session-persistence',
  ];
}

/** How a program is spawned with no shell: the command, the arguments before the turn's own, and whether cmd.exe runs it. */
export interface Program {
  command: string;
  prefix: string[];
  viaCmd: boolean;
}

const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1];

/**
 * How to run `claudePath` with no shell. A .js, .mjs or .cjs file runs under this node. On Windows a name with no
 * extension is looked up as .exe, then .cmd, then .bat (on PATH when it has no folder), and a .cmd or .bat runs through
 * `cmd.exe /d /s /c` (npm installs `claude` as claude.cmd, which no plain spawn can run).
 */
export function resolveProgram(claudePath: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Program {
  if (/\.(c|m)?js$/i.test(claudePath)) return { command: process.execPath, prefix: [claudePath], viaCmd: false };
  if (platform !== 'win32') return { command: claudePath, prefix: [], viaCmd: false };
  let full = claudePath;
  if (extname(claudePath) === '') {
    const dirs = /[\\/]/.test(claudePath) ? [''] : (envValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean);
    found: for (const dir of dirs) {
      for (const ext of ['.exe', '.cmd', '.bat']) {
        const candidate = dir === '' ? `${claudePath}${ext}` : join(dir, `${claudePath}${ext}`);
        if (existsSync(candidate)) {
          full = candidate;
          break found;
        }
      }
    }
  }
  return /\.(cmd|bat)$/i.test(full) ? { command: full, prefix: [], viaCmd: true } : { command: full, prefix: [], viaCmd: false };
}

/**
 * One argument quoted for `cmd.exe /d /s /c "..."` and the program's own parser. cmd.exe still reads % inside quotes, and
 * a quote or a line break cannot be carried safely, so an argument with one is refused, not mangled. A `!` passes: delayed
 * expansion is off under `cmd /d /s /c`, so cmd.exe reads it as itself.
 */
export function cmdQuote(arg: string): string {
  if (/["%\r\n]/.test(arg)) throw new Error(`cannot pass ${JSON.stringify(arg)} through cmd.exe: it holds a quote, % or a line break`);
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
}

/** taskkill by its full system path, `%SystemRoot%\System32\taskkill.exe`, so no other taskkill on PATH runs; 'taskkill' when SystemRoot is unset. */
export function taskkillPath(env: NodeJS.ProcessEnv): string {
  const root = envValue(env, 'SYSTEMROOT');
  return root ? join(root, 'System32', 'taskkill.exe') : 'taskkill';
}

/** Ends the child and, on Windows, every process under it; a taskkill that fails falls back to killing the child itself. */
export function killTree(pid: number | undefined, kill: () => void, opts: { platform?: NodeJS.Platform; taskkill?: string } = {}): void {
  if ((opts.platform ?? process.platform) === 'win32' && pid !== undefined) {
    execFile(opts.taskkill ?? taskkillPath(process.env), ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, (err) => {
      if (err) kill();
    });
    return;
  }
  kill();
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What the headless way needs: the program, the lead's folder, the tool server's entry, and for tests the kill and its grace. */
export interface HeadlessOptions {
  claudePath: string;
  leadDir: (slug: string) => string;
  toolsEntry: string;
  env?: NodeJS.ProcessEnv;
  /** How a run and what it started are ended; killTree by default, with the environment's taskkill. */
  killTree?: (pid: number | undefined, kill: () => void) => void;
  /** KILL_GRACE_MS unless given. */
  killGraceMs?: number;
}

/**
 * The headless way: `claude -p` (or INPROGRESS_LEAD_CLAUDE's program, see resolveProgram) in the lead's own folder, with
 * the turn's own system prompt and tool server config (desk-turn-<turnId>.md, tools-<turnId>.json, removed when the run
 * ends) and an empty project settings file written once, only the lead's MCP tools allowed, and the session variables
 * removed from its environment. The stream is read line by line; the signal kills the run and everything it started, and
 * a run that has not ended KILL_GRACE_MS after an abort or a kill is settled anyway. A run that does not answer rejects
 * with a TurnRunError carrying what it read; a fault writing its files or starting it is a runner fault, its files removed.
 */
export function headlessWay(opts: HeadlessOptions): TurnWay {
  return {
    name: 'headless',
    run(input, signal) {
      return new Promise<TurnOutput>((resolve, reject) => {
        if (signal.aborted) return reject(abortError(signal, { rateLimits: [] }));
        const env = opts.env ?? process.env;
        const endTree = opts.killTree ?? ((pid: number | undefined, kill: () => void) => killTree(pid, kill, { taskkill: taskkillPath(env) }));
        const dir = opts.leadDir(input.slug);
        const promptFile = join(dir, `desk-turn-${input.turnId}.md`);
        const toolsFile = join(dir, `tools-${input.turnId}.json`);
        const settingsFile = join(dir, '.claude', 'settings.json');
        const removeFiles = () => {
          for (const f of [promptFile, toolsFile]) {
            try {
              rmSync(f, { force: true });
            } catch {
              // A file Windows still holds open is left behind: it names its turn, so no later turn reads it.
            }
          }
        };
        let child: ChildProcessWithoutNullStreams;
        try {
          mkdirSync(join(dir, '.claude'), { recursive: true });
          writeFileSync(promptFile, input.systemPrompt);
          writeFileSync(toolsFile, JSON.stringify({ mcpServers: { 'inprogress-lead': { command: process.execPath, args: [opts.toolsEntry, input.slug], env: input.toolsEnv } } }, null, 2));
          if (!existsSync(settingsFile)) writeFileSync(settingsFile, '{}\n');
          const args = headlessArgs(input.model, promptFile, toolsFile);
          const program = resolveProgram(opts.claudePath, env);
          const command = program.viaCmd ? (envValue(env, 'COMSPEC') ?? 'cmd.exe') : program.command;
          const argv = program.viaCmd ? ['/d', '/s', '/c', `"${[program.command, ...program.prefix, ...args].map(cmdQuote).join(' ')}"`] : [...program.prefix, ...args];
          child = spawn(command, argv, {
            cwd: dir,
            env: turnEnv(env),
            windowsHide: true,
            windowsVerbatimArguments: program.viaCmd,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (err) {
          // A disk fault or a spawn that throws is the runner's, not the item's.
          removeFiles();
          return reject(new TurnRunError(`could not start ${opts.claudePath}: ${(err as Error).message}`, { rateLimits: [] }, true));
        }
        const rateLimits: unknown[] = [];
        let result: Record<string, unknown> | undefined;
        let model = input.model;
        let stderr = '';
        let exitWords = 'no exit code';
        let finished = false;
        let closed = false;
        let afterResult: NodeJS.Timeout | undefined;
        let grace: NodeJS.Timeout | undefined;
        // The run ends once both the child has closed and its stdout's last line is read, whichever comes last.
        let pending = 2;
        const kill = () => {
          endTree(child.pid, () => child.kill('SIGKILL'));
          // If neither taskkill nor the fallback ends it, the run is settled anyway, so its lane is never lost.
          if (grace === undefined) {
            grace = setTimeout(() => finish(conclude), opts.killGraceMs ?? KILL_GRACE_MS);
            grace.unref();
          }
        };
        signal.addEventListener('abort', kill, { once: true });
        const finish = (fn: () => void) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener('abort', kill);
          clearTimeout(afterResult);
          clearTimeout(grace);
          removeFiles();
          fn();
        };
        const settle = () => {
          if (--pending > 0) return;
          finish(conclude);
        };
        const partial = (): PartialOutput => {
          if (result === undefined) return { rateLimits, model };
          const usage = (result.usage ?? {}) as Record<string, unknown>;
          const denials = Array.isArray(result.permission_denials) ? (result.permission_denials as { tool_name?: unknown }[]) : [];
          return {
            costUsd: num(result.total_cost_usd),
            durationMs: num(result.duration_ms),
            tokensIn: num(usage.input_tokens),
            tokensOut: num(usage.output_tokens),
            refusedTools: denials.map((d) => String(d.tool_name ?? 'unknown')),
            rateLimits,
            model,
          };
        };
        const conclude = () => {
          // A result line read is the answer, whatever an abort that came after it says.
          if (result !== undefined) {
            if (typeof result.result !== 'string' || result.is_error === true) {
              const subtype = String(result.subtype ?? 'an error');
              // Running out of turns is the item's failure; any other error result (not logged in, a usage limit) is the runner's.
              return reject(new TurnRunError(`the turn ended with ${subtype}: ${typeof result.result === 'string' ? result.result : '(no result text)'}`, partial(), subtype !== 'error_max_turns'));
            }
            const p = partial();
            return resolve({
              text: result.result,
              costUsd: p.costUsd ?? null,
              durationMs: p.durationMs ?? null,
              tokensIn: p.tokensIn ?? null,
              tokensOut: p.tokensOut ?? null,
              refusedTools: p.refusedTools ?? [],
              rateLimits,
              model,
            });
          }
          if (signal.aborted) return reject(abortError(signal, partial()));
          reject(new TurnRunError(`${opts.claudePath} exited with ${exitWords} and no result line: ${stderr.trim().slice(-STDERR_TAIL_CHARS) || '(no stderr)'}`, partial(), true));
        };
        child.on('error', (err) => {
          // A program that never started (not found, not executable) has no exit to wait for.
          if (child.pid === undefined) finish(() => reject(new TurnRunError(`could not start ${opts.claudePath}: ${err.message}`, partial(), true)));
        });
        child.on('close', (code, sig) => {
          closed = true;
          exitWords = code !== null ? `code ${code}` : `signal ${sig ?? 'unknown'}`;
          settle();
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr = (stderr + chunk).slice(-4 * STDERR_TAIL_CHARS);
        });
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on('line', (line) => {
          let o: Record<string, unknown>;
          try {
            o = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // A line that is not JSON (a warning printed to stdout) carries nothing the turn needs.
            return;
          }
          if (o === null || typeof o !== 'object') return;
          if (o.type === 'rate_limit_event' && o.rate_limit_info !== undefined) rateLimits.push(o.rate_limit_info);
          else if (o.type === 'system' && o.subtype === 'init' && typeof o.model === 'string') model = o.model;
          else if (o.type === 'result' && result === undefined) {
            result = o;
            // The answer is in: a run that lingers (an MCP server holding it open) is ended.
            afterResult = setTimeout(() => {
              if (!closed) kill();
            }, AFTER_RESULT_KILL_MS);
            afterResult.unref();
          }
        });
        lines.on('close', settle);
        // A child that exits before reading its stdin breaks the pipe: the exit and its stderr tell the story, not this.
        child.stdin.on('error', () => undefined);
        child.stdin.end(input.userMessage);
      });
    },
  };
}

/** The abort's reason as a TurnRunError with what the run read: the runner reads the reason itself to tell whose fault it was. */
const abortError = (signal: AbortSignal, partial: PartialOutput): TurnRunError =>
  new TurnRunError(signal.reason instanceof Error ? signal.reason.message : 'the turn was stopped', partial, false);

/** The epoch seconds of a reset, as an ISO time; null when there is none. */
const resetIso = (seconds: unknown): string | null => (typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null);

/** One rate_limit_info as a usage reading: the five-hour window, the week, and any further window's utilization in other. */
export function readingOf(info: unknown, at: string, turnId: number, model: string): AddReadingInput {
  const windows = ((info as { unifiedWindows?: unknown } | null)?.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown } | null>;
  const more = Object.keys(windows).filter((k) => k !== 'five_hour' && k !== 'seven_day');
  return {
    at,
    source: 'turn',
    turnId,
    model,
    windowUsed: num(windows.five_hour?.utilization),
    windowResets: resetIso(windows.five_hour?.resetsAt),
    weekUsed: num(windows.seven_day?.utilization),
    weekResets: resetIso(windows.seven_day?.resetsAt),
    other: more.length === 0 ? null : JSON.stringify(Object.fromEntries(more.map((k) => [k, num(windows[k]?.utilization)]))),
  };
}

/** A plain apply for tests of the runner alone: the answer as the item's outcome, `<VERDICT>: <answer>`, and the item done. */
export function standInApply(_ctx: Ctx, turn: LeadTurn, _item: DeskItem, _record?: RecordEvent): TurnEffect {
  return { itemState: 'done', outcome: `${turn.verdict}: ${turn.answer}` };
}

export interface RunnerLog {
  info(message: string): void;
  error(message: string): void;
}

export interface RunnerOptions {
  way: TurnWay;
  model: string;
  /** The server's own home and port, which the turn's tool server reads. */
  home: string;
  port: number;
  leaseMs?: number;
  reflexPerProject?: number;
  tickMs?: number;
  /** What a verdict does: run inside the apply's write (immediate, as the project's lead), with that write's `record`. */
  apply: (ctx: Ctx, turn: LeadTurn, item: DeskItem, record: RecordEvent) => TurnEffect;
  /** Where each step is logged in one line: the server log. */
  log?: RunnerLog;
}

export interface Runner {
  start(): void;
  stop(): Promise<void>;
  kick(projectId: number): void;
  /** One tick now: recover, stop runs whose item left the desk, bring waiting items, then kick every project whose round is on. */
  tick(): void;
}

/** Aborts a run because the runner is stopping: the turn is interrupted, not counted against its item. */
const STOPPING = new Error('the server stopped during the turn');
/** Aborts a run whose item left the desk mid-run (cleared, its step deleted, the round off): interrupted, not counted. */
const ITEM_LEFT = new Error('the item left the desk during the turn');

/** How a run ended, for what the runner does next. */
type RunEnd = 'ok' | 'failed' | 'fault';

/**
 * The lead's turn runner. A lease is the only way into a turn, so two runners on one database never both run an item.
 * Each turn: leased, run with an abort at lease_until less ABORT_BEFORE_LEASE_END_MS, its usage readings written, its
 * answer parsed and saved, then applied by `apply` keyed on the item, in one immediate write. An answer that does not
 * parse, or a run killed at its lease's end, fails the turn; two failures leave the item behind. A runner fault (claude
 * would not run, or ended in error) interrupts the turn without counting against the item, and backs the project off.
 */
export function createRunner(ctx: Ctx, opts: RunnerOptions): Runner {
  const db = ctx.db;
  const leaseMs = opts.leaseMs ?? LEASE_MS;
  const reflexPerProject = opts.reflexPerProject ?? REFLEX_PER_PROJECT;
  const tickMs = opts.tickMs ?? TICK_MS;
  const log: RunnerLog = opts.log ?? { info: (m) => console.log(m), error: (m) => console.error(m) };
  const running = new Map<number, { projectId: number; itemId: number; lane: DeskLane; controller: AbortController; done: Promise<void> }>();
  /** Per project, until when no new lease is taken after a runner fault. */
  const backoff = new Map<number, number>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  /** How often each answered turn's apply has thrown in this runner. */
  const applyThrows = new Map<number, number>();
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const nowMs = (): number => Date.parse(ctx.now());

  /** The actor the apply writes as: the item's project's lead. */
  function actorOf(itemId: number): string {
    const lead = leadOfItem(db, itemId);
    return lead ? `lead:${lead}` : 'lead';
  }

  /** Applies a saved answer in one immediate write. A second throw for the same turn fails it. */
  function applySaved(turnId: number, itemId: number): void {
    try {
      const applied = write(ctx, actorOf(itemId), (record) => applyTurn(db, turnId, ctx.now(), (turn, item) => opts.apply(ctx, turn, item, record)), { immediate: true });
      if (applied) log.info(`Lead turn ${turnId}: applied to desk item #${itemId}: ${getDeskItem(db, itemId)?.outcome ?? ''}`);
      else log.info(`Lead turn ${turnId}: not applied, desk item #${itemId} was no longer leased to it (taken or cleared)`);
      applyThrows.delete(turnId);
    } catch (err) {
      const throws = (applyThrows.get(turnId) ?? 0) + 1;
      if (throws < APPLY_THROWS_FAIL) {
        applyThrows.set(turnId, throws);
        log.error(`Lead turn ${turnId}: the apply to desk item #${itemId} failed and is retried on the next tick: ${message(err)}`);
        return;
      }
      applyThrows.delete(turnId);
      try {
        const why = `the apply failed ${throws} times: ${message(err)}`;
        if (failAnsweredTurn(db, turnId, why, ctx.now())) log.error(`Lead turn ${turnId}: failed, ${why}; desk item #${itemId} is ${getDeskItem(db, itemId)?.state}`);
      } catch (failErr) {
        log.error(`Lead turn ${turnId}: the apply failed ${throws} times (${message(err)}), and the turn could not be failed: ${message(failErr)}`);
      }
    }
  }

  function recover(): void {
    for (const t of answeredTurns(db)) {
      log.info(`Lead turn ${t.id}: an answer saved and not applied, applied now without running again`);
      applySaved(t.id, t.itemId);
    }
    const now = ctx.now();
    for (const t of expiredLeases(db, now)) {
      if (failTurn(db, t.id, 'abandoned', 'the lease ran out with no answer', now)) {
        log.info(`Lead turn ${t.id}: abandoned, its lease ran out with no answer; desk item #${t.itemId} is ${getDeskItem(db, t.itemId)?.state}`);
      }
    }
  }

  /** A run whose item is no longer leased, or whose project left the round, is stopped. */
  function stopStrays(): void {
    for (const r of running.values()) {
      if (r.controller.signal.aborted) continue;
      if (getDeskItem(db, r.itemId)?.state !== 'leased' || !isLiveWithRound(db, r.projectId)) r.controller.abort(ITEM_LEFT);
    }
  }

  function tick(): void {
    if (stopped) return;
    try {
      recover();
      stopStrays();
      for (const projectId of liveProjectsWithRound(db)) {
        try {
          const brought = db.transaction(() => bringNext(ctx, projectId)).immediate();
          if (brought.length > 0) log.info(`Lead runner: brought ${brought.map((id) => `d${id}`).join(', ')} to Aiden in project ${projectId}`);
        } catch (err) {
          log.error(`Lead runner: could not bring waiting items to Aiden in project ${projectId}: ${message(err)}`);
        }
        kick(projectId);
      }
    } catch (err) {
      log.error(`Lead runner: the tick failed: ${message(err)}`);
    }
  }

  const inLane = (projectId: number, lane: DeskLane): number => [...running.values()].filter((r) => r.projectId === projectId && r.lane === lane).length;

  /** Whether the project takes no new lease now: backing off after a fault, or after it one try already running. */
  function backedOff(projectId: number): boolean {
    const until = backoff.get(projectId);
    if (until === undefined) return false;
    if (nowMs() < until) return true;
    return [...running.values()].some((r) => r.projectId === projectId);
  }

  function kick(projectId: number): void {
    if (stopped) return;
    try {
      if (!isLiveWithRound(db, projectId) || backedOff(projectId)) return;
      const project = getProjectById(ctx, projectId);
      // A project with no lead has no one to answer as: the tool server refuses to start without the lead's name.
      if (project === undefined || project.lead === null || project.lead.trim() === '') return;
      fill(project, 'reflex', reflexPerProject);
      fill(project, 'old', 1);
    } catch (err) {
      log.error(`Lead runner: could not look at the desk of project ${projectId}: ${message(err)}`);
    }
  }

  function fill(project: Project, lane: DeskLane, max: number): void {
    while (!stopped && inLane(project.id, lane) < max && !backedOff(project.id)) {
      let turn: LeadTurn | undefined;
      for (const itemId of openItemsInLane(db, project.id, lane)) {
        turn = leaseItem(db, itemId, { way: opts.way.name, model: opts.model, leaseMs }, ctx.now());
        if (turn !== undefined) break;
      }
      if (turn === undefined) return;
      begin(turn, project, lane);
    }
  }

  function begin(turn: LeadTurn, project: Project, lane: DeskLane): void {
    const controller = new AbortController();
    const entry = { projectId: project.id, itemId: turn.itemId, lane, controller, done: Promise.resolve() };
    running.set(turn.id, entry);
    entry.done = runTurn(turn, project, lane, controller)
      .catch((err: unknown): RunEnd => {
        log.error(`Lead turn ${turn.id}: ${message(err)}`);
        return 'failed';
      })
      .then((end) => {
        running.delete(turn.id);
        // A run that ended without a fault proves claude runs again, but only a back-off that has run out is dropped: one a
        // sibling run's fault just set stays. 'failed' counts too: claude ran and answered, the item was at fault.
        const until = backoff.get(project.id);
        if (end !== 'fault' && until !== undefined && nowMs() >= until) backoff.delete(project.id);
        // Its lane is free: the next waiting item may run. After a failure the next tick looks again, so an item that just
        // failed is not leased again at once.
        if (end === 'ok' && !stopped) kick(project.id);
      });
  }

  function logFail(turnId: number, itemId: number, state: 'failed' | 'abandoned' | 'interrupted', why: string, moved: boolean): void {
    if (moved) log.info(`Lead turn ${turnId}: ${state}, ${why}; desk item #${itemId} is ${getDeskItem(db, itemId)?.state}`);
    else log.info(`Lead turn ${turnId}: ${why}, and the turn was no longer leased (its lease ran out): nothing written`);
  }

  /** The run's usage readings, one per rate_limit_info. A failure to write them is logged: the gauge must not lose the answer. */
  function writeReadings(turnId: number, rateLimits: unknown[], model: string): void {
    if (rateLimits.length === 0) return;
    try {
      const at = ctx.now();
      db.transaction(() => {
        for (const info of rateLimits) addReading(db, readingOf(info, at, turnId, model));
      })();
      log.info(`Lead turn ${turnId}: ${rateLimits.length} usage readings written`);
    } catch (err) {
      log.error(`Lead turn ${turnId}: could not write its usage readings: ${message(err)}`);
    }
  }

  const costsOf = (startedAt: string, o: PartialOutput): TurnFields => ({
    startedAt,
    ...(o.costUsd == null ? {} : { costUsd: o.costUsd }),
    ...(o.durationMs == null ? {} : { durationMs: o.durationMs }),
    ...(o.tokensIn == null ? {} : { tokensIn: o.tokensIn }),
    ...(o.tokensOut == null ? {} : { tokensOut: o.tokensOut }),
    ...(o.refusedTools === undefined ? {} : { refusedTools: o.refusedTools }),
  });

  async function runTurn(turn: LeadTurn, project: Project, lane: DeskLane, controller: AbortController): Promise<RunEnd> {
    const item = getDeskItem(db, turn.itemId)!;
    log.info(`Lead turn ${turn.id}: leased desk item #${item.id} (${item.kind} ${item.ref}) of ${project.slug} in the ${lane} lane, ${opts.way.name}, until ${turn.leaseUntil}`);
    const startedAt = ctx.now();
    const abortAt = Date.parse(turn.leaseUntil) - ABORT_BEFORE_LEASE_END_MS - Date.parse(startedAt);
    const timeout = setTimeout(() => controller.abort(new Error(`the run was stopped ${ABORT_BEFORE_LEASE_END_MS / 1000} seconds before its lease ends`)), Math.max(0, abortAt));
    let output: TurnOutput;
    try {
      const repo = leadFolders(ctx, project.id)[0];
      const toolsEnv: ToolsEnv = {
        INPROGRESS_HOME: opts.home,
        INPROGRESS_PORT: String(opts.port),
        INPROGRESS_LEAD_AS: project.lead!.trim(),
        ...(repo === undefined ? {} : { INPROGRESS_LEAD_REPO: repo }),
      };
      const input: TurnInput = { turnId: turn.id, slug: project.slug, item, systemPrompt: deskSystemPrompt(ctx, project), userMessage: deskUserMessage(ctx, item), model: opts.model, toolsEnv };
      output = await opts.way.run(input, controller.signal);
    } catch (err) {
      const partial = err instanceof TurnRunError ? err.partial : { rateLimits: [] };
      writeReadings(turn.id, partial.rateLimits, partial.model ?? opts.model);
      const reason = controller.signal.reason;
      const interrupted = reason === STOPPING || reason === ITEM_LEFT;
      const fault = !interrupted && err instanceof TurnRunError && err.runnerFault;
      const state = interrupted || fault ? 'interrupted' : 'failed';
      const why = interrupted ? (reason as Error).message : fault ? `${RUNNER_FAULT_WHY}: ${message(err)}` : `the ${opts.way.name} run failed: ${message(err)}`;
      logFail(turn.id, item.id, state, why, failTurn(db, turn.id, state, why, ctx.now(), costsOf(startedAt, partial)));
      if (fault) {
        const already = (backoff.get(project.id) ?? 0) > nowMs();
        backoff.set(project.id, nowMs() + FAULT_BACKOFF_MS);
        if (!already) log.error(`Lead runner: ${project.slug} backs off for ${FAULT_BACKOFF_MS / 60_000} minutes, then tries one turn: ${message(err)}`);
        return 'fault';
      }
      return 'failed';
    } finally {
      clearTimeout(timeout);
    }
    const costs = costsOf(startedAt, output);
    log.info(`Lead turn ${turn.id}: ran in ${output.durationMs ?? '?'} ms for $${output.costUsd ?? '?'}, ${output.tokensIn ?? '?'} tokens in and ${output.tokensOut ?? '?'} out, ${output.refusedTools.length} tools refused`);
    writeReadings(turn.id, output.rateLimits, output.model);
    const parsed = parseVerdict(output.text);
    if (!parsed.ok) {
      const why = `the answer did not parse: ${parsed.reason}`;
      logFail(turn.id, item.id, 'failed', why, failTurn(db, turn.id, 'failed', why, ctx.now(), costs));
      return 'failed';
    }
    const v = parsed.value;
    if (!saveAnswer(db, turn.id, { ...costs, verdict: v.verdict, kind: v.kind, answer: v.answer, why: v.why }, ctx.now())) {
      log.info(`Lead turn ${turn.id}: answered ${v.verdict}, but the turn was no longer leased (its lease ran out): nothing saved`);
      return 'ok';
    }
    log.info(`Lead turn ${turn.id}: answer saved, ${v.verdict} ${v.kind}: ${v.answer}`);
    applySaved(turn.id, item.id);
    return 'ok';
  }

  return {
    start() {
      if (stopped || timer !== undefined) return;
      unsubscribe = onDeskItem((projectId) => kick(projectId));
      timer = setInterval(tick, tickMs);
      timer.unref();
      tick();
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      clearInterval(timer);
      const runs = [...running.values()];
      for (const r of runs) r.controller.abort(STOPPING);
      let deadline: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((resolve) => {
        deadline = setTimeout(() => resolve('late'), STOP_WAIT_MS);
      });
      const end = await Promise.race([Promise.all(runs.map((r) => r.done)).then(() => 'done' as const), late]);
      clearTimeout(deadline);
      if (end === 'late') log.error(`Lead runner: ${running.size} turns did not end within ${STOP_WAIT_MS} ms of the stop; their leases run out`);
    },
    kick,
    tick,
  };
}
