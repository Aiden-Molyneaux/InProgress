import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Project } from '../../core/types';
import type { Ctx } from '../db/tx';
import { leadFolders } from '../lead';
import { getDeskItem, type DeskItem } from '../repo/desk';
import { onDeskItem } from '../repo/deskProducers';
import { applyTurn, failTurn, leaseItem, saveAnswer, type LeadTurn, type TurnEffect } from '../repo/leadTurns';
import { getProjectById } from '../repo/projects';
import { roundSince } from '../repo/switches';
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

/** A way to run a desk turn: headless (`claude -p`), or a message in the lead's thread (task 12). */
export interface TurnWay {
  name: 'headless' | 'thread';
  run(input: TurnInput, signal: AbortSignal): Promise<TurnOutput>;
}

/** dist/lead/tools.js, resolved from the server's bundle (dist/server/main.js) as ensure-server.ts resolves the server's. */
export function leadToolsEntry(): string {
  return fileURLToPath(new URL('../lead/tools.js', import.meta.url));
}

/**
 * The server's environment without the variables of the Claude session or T3 Code thread that may have started it: a
 * turn is no session's child. Names are compared in capitals, as Windows treats them.
 */
export function turnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const u = name.toUpperCase();
    if (u === 'CLAUDECODE' || u === 'CLAUDE_PID' || u === 'CLAUDE_EFFORT') continue;
    if (u.startsWith('CLAUDE_CODE_') || u.startsWith('CLAUDE_AGENT_') || u.startsWith('T3CODE_')) continue;
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

/** Ends the child and, on Windows, every process under it. */
function killTree(pid: number | undefined, kill: () => void): void {
  if (process.platform === 'win32' && pid !== undefined) {
    // An error here means the tree already ended between the abort and the kill: nothing is left to stop.
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => undefined);
    return;
  }
  kill();
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The headless way: `claude -p` (or INPROGRESS_LEAD_CLAUDE's program; a .js, .mjs or .cjs one runs under this node) in the
 * lead's own folder, with its system prompt, its tool server's config and an empty project settings file written there,
 * only the lead's MCP tools allowed, and the session variables removed from its environment. The stream is read line by
 * line; the signal kills the run and everything it started.
 */
export function headlessWay(opts: { claudePath: string; leadDir: (slug: string) => string; toolsEntry: string; env?: NodeJS.ProcessEnv }): TurnWay {
  return {
    name: 'headless',
    run(input, signal) {
      return new Promise<TurnOutput>((resolve, reject) => {
        if (signal.aborted) return reject(abortError(signal));
        const dir = opts.leadDir(input.slug);
        mkdirSync(join(dir, '.claude'), { recursive: true });
        const promptFile = join(dir, 'desk-turn.md');
        const toolsFile = join(dir, 'tools.json');
        writeFileSync(promptFile, input.systemPrompt);
        writeFileSync(toolsFile, JSON.stringify({ mcpServers: { 'inprogress-lead': { command: process.execPath, args: [opts.toolsEntry, input.slug], env: input.toolsEnv } } }, null, 2));
        writeFileSync(join(dir, '.claude', 'settings.json'), '{}\n');
        const args = headlessArgs(input.model, promptFile, toolsFile);
        const viaNode = /\.(c|m)?js$/i.test(opts.claudePath);
        const child = spawn(viaNode ? process.execPath : opts.claudePath, viaNode ? [opts.claudePath, ...args] : args, {
          cwd: dir,
          env: turnEnv(opts.env ?? process.env),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const rateLimits: unknown[] = [];
        let result: Record<string, unknown> | undefined;
        let model = input.model;
        let stderr = '';
        let exitWords = 'no exit code';
        let finished = false;
        // The run ends once both the child has closed and its stdout's last line is read, whichever comes last.
        let pending = 2;
        const onAbort = () => killTree(child.pid, () => child.kill('SIGKILL'));
        signal.addEventListener('abort', onAbort, { once: true });
        const finish = (fn: () => void) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener('abort', onAbort);
          fn();
        };
        const settle = () => {
          if (--pending > 0) return;
          finish(() => conclude());
        };
        const conclude = () => {
          if (signal.aborted) return reject(abortError(signal));
          if (result === undefined) return reject(new Error(`${opts.claudePath} exited with ${exitWords} and no result line: ${stderr.trim().slice(-STDERR_TAIL_CHARS) || '(no stderr)'}`));
          if (typeof result.result !== 'string' || result.is_error === true) {
            return reject(new Error(`the turn ended with ${String(result.subtype ?? 'an error')}: ${typeof result.result === 'string' ? result.result : '(no result text)'}`));
          }
          const usage = (result.usage ?? {}) as Record<string, unknown>;
          const denials = Array.isArray(result.permission_denials) ? (result.permission_denials as { tool_name?: unknown }[]) : [];
          resolve({
            text: result.result,
            costUsd: num(result.total_cost_usd),
            durationMs: num(result.duration_ms),
            tokensIn: num(usage.input_tokens),
            tokensOut: num(usage.output_tokens),
            refusedTools: denials.map((d) => String(d.tool_name ?? 'unknown')),
            rateLimits,
            model,
          });
        };
        child.on('error', (err) => {
          // A program that never started (not found, not executable) has no exit to wait for.
          if (child.pid === undefined) finish(() => reject(new Error(`could not start ${opts.claudePath}: ${err.message}`)));
        });
        child.on('close', (code, sig) => {
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
          else if (o.type === 'result') result = o;
        });
        lines.on('close', settle);
        // A child that exits before reading its stdin breaks the pipe: the exit and its stderr tell the story, not this.
        child.stdin.on('error', () => undefined);
        child.stdin.end(input.userMessage);
      });
    },
  };
}

const abortError = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error('the turn was stopped'));

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

/** Until task 5: the answer applied as the item's outcome alone, `<VERDICT>: <answer>`, and the item done. */
export function standInApply(_ctx: Ctx, turn: LeadTurn, _item: DeskItem): TurnEffect {
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
  apply: (ctx: Ctx, turn: LeadTurn, item: DeskItem) => TurnEffect;
  /** Where each step is logged in one line: the server log. */
  log?: RunnerLog;
}

export interface Runner {
  start(): void;
  stop(): Promise<void>;
  kick(projectId: number): void;
  /** One tick now: recover, then kick every project whose round is on. start() runs one, then one every tickMs. */
  tick(): void;
}

type Lane = 'reflex' | 'old';

/** Aborts a run because the runner is stopping, so its turn is abandoned rather than failed by its own fault. */
const STOPPING = new Error('the server stopped during the turn');

/**
 * The lead's turn runner. A lease is the only way into a turn, so two runners on one database never both run an item.
 * Each turn: leased, run with an abort at lease_until less ABORT_BEFORE_LEASE_END_MS, its usage readings written, its
 * answer parsed and saved, then applied by `apply` keyed on the item. A run that throws, or an answer that does not
 * parse, fails the turn; two failures leave the item behind.
 */
export function createRunner(ctx: Ctx, opts: RunnerOptions): Runner {
  const db = ctx.db;
  const leaseMs = opts.leaseMs ?? LEASE_MS;
  const reflexPerProject = opts.reflexPerProject ?? REFLEX_PER_PROJECT;
  const tickMs = opts.tickMs ?? TICK_MS;
  const log: RunnerLog = opts.log ?? { info: (m) => console.log(m), error: (m) => console.error(m) };
  const running = new Map<number, { projectId: number; lane: Lane; controller: AbortController; done: Promise<void> }>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /** Applies a saved answer. Logs the outcome; an apply that throws leaves the turn answered for the next recovery. */
  function applySaved(turnId: number, itemId: number): void {
    try {
      if (applyTurn(db, turnId, ctx.now(), (turn, item) => opts.apply(ctx, turn, item))) {
        log.info(`Lead turn ${turnId}: applied to desk item #${itemId}: ${getDeskItem(db, itemId)?.outcome ?? ''}`);
      } else {
        log.info(`Lead turn ${turnId}: not applied, desk item #${itemId} was no longer leased to it (taken or cleared)`);
      }
    } catch (err) {
      log.error(`Lead turn ${turnId}: the apply to desk item #${itemId} failed and is retried on the next tick: ${message(err)}`);
    }
  }

  function recover(): void {
    const answered = db.prepare("SELECT id, item_id FROM lead_turns WHERE state = 'answered' ORDER BY id").all() as { id: number; item_id: number }[];
    for (const t of answered) {
      log.info(`Lead turn ${t.id}: an answer saved and not applied, applied now without running again`);
      applySaved(t.id, t.item_id);
    }
    const now = ctx.now();
    const expired = db.prepare("SELECT id, item_id FROM lead_turns WHERE state = 'leased' AND lease_until < ? ORDER BY id").all(now) as { id: number; item_id: number }[];
    for (const t of expired) {
      if (failTurn(db, t.id, 'abandoned', 'the lease ran out with no answer', now)) {
        log.info(`Lead turn ${t.id}: abandoned, its lease ran out with no answer; desk item #${t.item_id} is ${getDeskItem(db, t.item_id)?.state}`);
      }
    }
  }

  function tick(): void {
    if (stopped) return;
    try {
      recover();
    } catch (err) {
      log.error(`Lead runner: recovery failed: ${message(err)}`);
    }
    const projects = db.prepare("SELECT id FROM projects WHERE status = 'active' AND deleted_at IS NULL ORDER BY id").pluck().all() as number[];
    for (const projectId of projects) {
      if (roundSince(db, projectId) !== null) kick(projectId);
    }
  }

  const inLane = (projectId: number, lane: Lane): number => [...running.values()].filter((r) => r.projectId === projectId && r.lane === lane).length;

  function kick(projectId: number): void {
    if (stopped) return;
    try {
      if (roundSince(db, projectId) === null) return;
      const live = db.prepare("SELECT 1 FROM projects WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(projectId) !== undefined;
      const project = live ? getProjectById(ctx, projectId) : undefined;
      // A project with no lead has no one to answer as: the tool server refuses to start without the lead's name.
      if (project === undefined || project.lead === null || project.lead.trim() === '') return;
      fill(project, 'reflex', reflexPerProject);
      fill(project, 'old', 1);
    } catch (err) {
      log.error(`Lead runner: could not look at the desk of project ${projectId}: ${message(err)}`);
    }
  }

  function fill(project: Project, lane: Lane, max: number): void {
    const kindTerm = lane === 'old' ? "kind = 'old_ask'" : "kind <> 'old_ask'";
    const candidates = db.prepare(`SELECT id FROM desk_items WHERE project_id = ? AND state = 'open' AND ${kindTerm} ORDER BY created_at, id`).pluck();
    while (!stopped && inLane(project.id, lane) < max) {
      let turn: LeadTurn | undefined;
      for (const itemId of candidates.all(project.id) as number[]) {
        turn = leaseItem(db, itemId, { way: opts.way.name, model: opts.model, leaseMs }, ctx.now());
        if (turn !== undefined) break;
      }
      if (turn === undefined) return;
      begin(turn, project, lane);
    }
  }

  function begin(turn: LeadTurn, project: Project, lane: Lane): void {
    const controller = new AbortController();
    const entry = { projectId: project.id, lane, controller, done: Promise.resolve() };
    running.set(turn.id, entry);
    entry.done = runTurn(turn, project, lane, controller)
      .catch((err: unknown) => log.error(`Lead turn ${turn.id}: ${message(err)}`))
      .finally(() => {
        running.delete(turn.id);
        // Its lane is free: the next waiting item may run.
        if (!stopped) kick(project.id);
      });
  }

  function logFail(turnId: number, itemId: number, state: 'failed' | 'abandoned', why: string, moved: boolean): void {
    if (moved) log.info(`Lead turn ${turnId}: ${state}, ${why}; desk item #${itemId} is ${getDeskItem(db, itemId)?.state}`);
    else log.info(`Lead turn ${turnId}: ${why}, and the turn was no longer leased (its lease ran out): nothing written`);
  }

  async function runTurn(turn: LeadTurn, project: Project, lane: Lane, controller: AbortController): Promise<void> {
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
      const input: TurnInput = { slug: project.slug, item, systemPrompt: deskSystemPrompt(ctx, project), userMessage: deskUserMessage(ctx, item), model: opts.model, toolsEnv };
      output = await opts.way.run(input, controller.signal);
    } catch (err) {
      const stopping = controller.signal.reason === STOPPING;
      const why = stopping ? STOPPING.message : `the ${opts.way.name} run failed: ${message(err)}`;
      logFail(turn.id, item.id, stopping ? 'abandoned' : 'failed', why, failTurn(db, turn.id, stopping ? 'abandoned' : 'failed', why, ctx.now()));
      return;
    } finally {
      clearTimeout(timeout);
    }
    const costs = {
      startedAt,
      ...(output.costUsd === null ? {} : { costUsd: output.costUsd }),
      ...(output.durationMs === null ? {} : { durationMs: output.durationMs }),
      ...(output.tokensIn === null ? {} : { tokensIn: output.tokensIn }),
      ...(output.tokensOut === null ? {} : { tokensOut: output.tokensOut }),
      refusedTools: output.refusedTools,
    };
    log.info(`Lead turn ${turn.id}: ran in ${output.durationMs ?? '?'} ms for $${output.costUsd ?? '?'}, ${output.tokensIn ?? '?'} tokens in and ${output.tokensOut ?? '?'} out, ${output.refusedTools.length} tools refused`);
    try {
      const at = ctx.now();
      db.transaction(() => {
        for (const info of output.rateLimits) addReading(db, readingOf(info, at, turn.id, output.model));
      })();
      if (output.rateLimits.length > 0) log.info(`Lead turn ${turn.id}: ${output.rateLimits.length} usage readings written`);
    } catch (err) {
      // The readings are a gauge, not the answer: a failure to write them must not lose the answer.
      log.error(`Lead turn ${turn.id}: could not write its usage readings: ${message(err)}`);
    }
    const parsed = parseVerdict(output.text);
    if (!parsed.ok) {
      const why = `the answer did not parse: ${parsed.reason}`;
      logFail(turn.id, item.id, 'failed', why, failTurn(db, turn.id, 'failed', why, ctx.now(), costs));
      return;
    }
    const v = parsed.value;
    if (!saveAnswer(db, turn.id, { ...costs, verdict: v.verdict, kind: v.kind, answer: v.answer, why: v.why }, ctx.now())) {
      log.info(`Lead turn ${turn.id}: answered ${v.verdict}, but the turn was no longer leased (its lease ran out): nothing saved`);
      return;
    }
    log.info(`Lead turn ${turn.id}: answer saved, ${v.verdict} ${v.kind}: ${v.answer}`);
    applySaved(turn.id, item.id);
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
      await Promise.all(runs.map((r) => r.done));
    },
    kick,
    tick,
  };
}
