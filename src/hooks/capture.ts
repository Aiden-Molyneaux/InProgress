import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '../lib/home';
import type { HookName, HookStdin } from './handlers';

/**
 * Hook capture (Task 0 of the 2026-10-07 activity design): a short-lived record of what Claude Code really sends the
 * hooks, so the background-command, busy and re-home build can be checked against real payloads before it relies on
 * them. On by default in this build. Each captured hook appends one redacted JSON line to
 * `~/.inprogress/capture/<yyyy-mm-dd>.jsonl` (local date; INPROGRESS_HOME moves it with the data dir).
 *
 * Turn it off with either:
 * - the env var INPROGRESS_HOOK_CAPTURE=0 (also `off`, `false` or `no`) in the environment Claude Code runs hooks with;
 * - a file named `off` in the capture folder: `~/.inprogress/capture/off` (any content, even empty). No restart needed.
 *
 * It never blocks and never fails the hook: every error is swallowed, and nothing is printed.
 */

/** Per local day: once a day's file would pass this, that day captures nothing more (a `<day>.capped` file says so). */
export const CAPTURE_MAX_BYTES = 20 * 1024 * 1024;
/** One line past this is replaced by a stub naming its size. */
export const CAPTURE_LINE_MAX = 64 * 1024;
/** How much of a command, a message or an output is kept. */
export const COMMAND_KEEP = 80;
/** Every other string is clipped to this. */
export const TEXT_KEEP = 300;
/** A task-notification block is clipped to this, after its result is dropped. */
export const NOTICE_KEEP = 2000;
const NOTICES_MAX = 20;
const ARRAY_MAX = 100;
const DEPTH_MAX = 8;

/** PostToolUse on these tools is captured; every other tool is not. */
export const CAPTURED_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Monitor', 'SendMessage', 'TaskStop']);
const OFF_VALUES = new Set(['0', 'off', 'false', 'no']);

/** A field whose name reads like a credential: its value is never written. */
const SECRET_FIELD = /token|secret|passw|key|credential|authorization|cookie/i;
/** Free text that can hold anything (a command, a message to an agent, an output): only its start is kept. */
const SHORT_FIELDS = new Set(['command', 'message', 'prompt', 'last_assistant_message', 'stdout', 'stderr', 'output']);
/** A credential written inline in a kept string: `token=…`, `"apiKey": "…"`, `--password …`, `Bearer …`, `sk-…`. */
const SECRET_WORD = String.raw`[\w-]*(?:token|secret|passw(?:or)?d|api[-_]?key|credential)[\w-]*`;
const ASSIGNED_SECRET = new RegExp(String.raw`\b(${SECRET_WORD}["']?\s*[:=]\s*["']?)[^\s"'&;|,]+`, 'gi');
const FLAG_SECRET = new RegExp(String.raw`(--?${SECRET_WORD}\s+["']?)[^\s"'&;|]+`, 'gi');
const BEARER = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gi;
const KEY_LIKE = /\b(?:sk|pk|ghp|gho|github_pat|xox[abpr])[-_][\w-]{8,}/g;

export function captureDir(home: string = homeDir()): string {
  return join(home, 'capture');
}

/** On unless INPROGRESS_HOOK_CAPTURE says off, or the capture folder holds a file named `off`. */
export function captureEnabled(env: NodeJS.ProcessEnv = process.env, home: string = homeDir()): boolean {
  const flag = env.INPROGRESS_HOOK_CAPTURE?.trim().toLowerCase();
  if (flag && OFF_VALUES.has(flag)) return false;
  return !existsSync(join(captureDir(home), 'off'));
}

/** Stop, SubagentStop (both carry background_tasks) and UserPromptSubmit always; PostToolUse only for the tools the design reads. */
export function shouldCapture(name: HookName, input: HookStdin): boolean {
  if (name === 'stop' || name === 'subagent-stop' || name === 'prompt-submit') return true;
  return name === 'post-tool' && typeof input.tool_name === 'string' && CAPTURED_TOOLS.has(input.tool_name);
}

/**
 * Scrubbed, then cut to `max` with a marker giving the original length. Scrubbing before the cut means a credential the
 * cut would split is still caught; only a little past `max` is scrubbed, so a long output costs nothing.
 */
function keep(s: string, max: number): string {
  const kept = scrub(s.slice(0, max + 100));
  return kept.length > max || s.length > max + 100 ? `${kept.slice(0, max)}…[${s.length} chars]` : kept;
}

/** Inline credentials replaced by `[redacted]`. */
export function scrub(s: string): string {
  return s.replace(BEARER, '$1 [redacted]').replace(KEY_LIKE, '[redacted]').replace(ASSIGNED_SECRET, '$1[redacted]').replace(FLAG_SECRET, '$1[redacted]');
}

function redactValue(value: unknown, key: string | undefined, depth: number): unknown {
  if (key !== undefined && SECRET_FIELD.test(key)) return '[redacted]';
  if (typeof value === 'string') return keep(value, key !== undefined && SHORT_FIELDS.has(key) ? COMMAND_KEEP : TEXT_KEEP);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= DEPTH_MAX) return '[too deep]';
  if (Array.isArray(value)) {
    const kept = value.slice(0, ARRAY_MAX).map((v) => redactValue(v, undefined, depth + 1));
    if (value.length > ARRAY_MAX) kept.push(`[+${value.length - ARRAY_MAX} more]`);
    return kept;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, k, depth + 1)]));
}

/**
 * Every `<task-notification>` block in a prompt, in order, at most 20. A block's `<result>` (a subagent's whole report)
 * is dropped, keeping its length; the rest is scrubbed and clipped. An unclosed block runs to the end of the prompt.
 */
export function taskNotifications(prompt: string): string[] {
  const blocks = prompt.match(/<task-notification\b[\s\S]*?(?:<\/task-notification>|$)/g) ?? [];
  return blocks
    .slice(0, NOTICES_MAX)
    .map((b) => b.replace(/<result>([\s\S]*?)(<\/result>|$)/g, (_m, inner: string, close: string) => `<result>[${inner.length} chars dropped]${close}`))
    .map((b) => keep(b, NOTICE_KEEP));
}

/**
 * The stdin a hook got, as it is written to the capture: secret-named fields gone, commands, messages and outputs cut
 * to their first 80 characters, other strings to 300. UserPromptSubmit's prompt never goes in: only whether it holds a
 * task notification, and those blocks.
 */
export function redactInput(name: HookName, input: HookStdin): Record<string, unknown> {
  const { prompt, ...rest } = input;
  const out = redactValue(rest, undefined, 0) as Record<string, unknown>;
  if (name === 'prompt-submit' && typeof prompt === 'string') {
    const notices = taskNotifications(prompt);
    out.prompt_chars = prompt.length;
    out.prompt_starts_with_task_notification = /^\s*<task-notification\b/.test(prompt);
    out.has_task_notification = notices.length > 0;
    if (notices.length) out.task_notifications = notices;
  }
  return out;
}

/** Local date, so a day's file is the owner's day. */
function day(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface CaptureOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  maxBytes?: number;
}

/**
 * Appends one line for this hook's input when capture is on and the hook is one the design needs. Returns whether a line
 * was written (for tests). Never throws.
 */
export function captureHookInput(name: HookName, input: HookStdin, o: CaptureOptions = {}): boolean {
  try {
    const home = o.home ?? homeDir();
    if (!shouldCapture(name, input) || !captureEnabled(o.env ?? process.env, home)) return false;
    const now = o.now ?? new Date();
    const maxBytes = o.maxBytes ?? CAPTURE_MAX_BYTES;
    const dir = captureDir(home);
    const file = join(dir, `${day(now)}.jsonl`);
    const capped = join(dir, `${day(now)}.capped`);
    if (existsSync(capped)) return false;
    let line = JSON.stringify({ ts: now.toISOString(), hook: name, input: redactInput(name, input) });
    if (Buffer.byteLength(line) > CAPTURE_LINE_MAX) {
      line = JSON.stringify({ ts: now.toISOString(), hook: name, tool: typeof input.tool_name === 'string' ? input.tool_name : undefined, oversized: Buffer.byteLength(line) });
    }
    line += '\n';
    mkdirSync(dir, { recursive: true });
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // no file yet today
    }
    if (size + Buffer.byteLength(line) > maxBytes) {
      writeFileSync(capped, `${now.toISOString()} capture stopped at ${size} bytes (cap ${maxBytes})\n`);
      return false;
    }
    appendFileSync(file, line);
    return true;
  } catch {
    return false;
  }
}
