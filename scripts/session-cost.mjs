#!/usr/bin/env node
// Prices InProgress dev work from Claude Code's own session transcripts, so sessions run under
// different routing setups can be compared. Read-only: scans every
// ~/.claude/projects/C--personal-InProgress* directory (the repo, its worktrees, .live-check)
// and runs read-only git commands against this repo.
//
//   node scripts/session-cost.mjs                          cost per branch, all time
//   node scripts/session-cost.mjs --by=session             cost per session
//   node scripts/session-cost.mjs --since=2026-10-09       only requests on or after that date
//   node scripts/session-cost.mjs --sessions=ab12cd34,ef56 only these sessions (id prefixes), e.g. a pilot's
//   node scripts/session-cost.mjs --exclude=c0dc2f4d       leave these sessions out
//
// Costs are API-equivalent list prices (USD), not what a subscription bills. They exist to
// compare sessions and branches against each other, nothing else.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const PREFIX = 'C--personal-InProgress';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// USD per million tokens, list price (claude-api skill, cached 2026-10-06, checked 2026-10-09).
// Cache writes are priced from input: 5-minute at 1.25x, 1-hour at 2x. Cache reads vary by model
// (Opus 5.5 0.05x, Fable 5.1 0.025x, most others 0.1x). A model with `long` switches to those
// rates when the prompt is over `over`.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { input: 0.5, output: 2.5, cacheRead: 0.05, over: 100_000 } },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};
const modelKey = (m) => m.replace(/-\d{8}$/, '');

// A main-session request that writes at least half its prompt to cache, on a prompt this big,
// is a cold re-write: the cache expired (an idle gap) or was invalidated, and the whole context
// was paid for again at the write rate.
const COLD_MIN = 50_000;

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
const list = (name) => arg(name).split(',').filter(Boolean);
const BY = arg('by') || 'branch';
const SINCE = arg('since');
const ONLY = list('sessions');
const EXCLUDE = list('exclude');
if (!['branch', 'session'].includes(BY)) {
  console.error(`--by takes branch or session, not "${BY}".`);
  process.exit(1);
}

function git(args) {
  try {
    return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

// ---- Attribution -------------------------------------------------------------------------------
// Sessions here edit worktrees by path from the main checkout, so `gitBranch` on a transcript
// line says `main` for nearly all work. Each request is attributed to the branch the session was
// last working on: walking the transcript in order, a line switches the current branch when its
// `gitBranch` is a feature branch, when a tool call touches `.claude/worktrees/<name>`, or when a
// command creates a branch. A `git merge` run in the main checkout ends the branch: what follows
// is `(main)` (planning, landing, chat) until the next marker.

const MAIN = '(main)';
const MAIN_BRANCHES = new Set(['main', 'master', 'HEAD', '']);
const WT_RE = /\.claude[\\/]+worktrees[\\/]+([A-Za-z0-9._-]+)/g;
const NEW_BRANCH_RE = /\bgit\b[^\n;&|]*?\b(?:checkout\s+-[bB]|switch\s+-[cC]|worktree\s+add\b[^\n;&|]*?\s-[bB])\s+([A-Za-z0-9._/-]+)/g;
const WT_ADD_RE = /\bworktree\s+add\b[^\n;&|]*/g;
const MERGE_RE = /\bgit\s+merge\b/;

// Worktree directory name -> branch: the live worktree list, plus `git worktree add` commands
// seen in transcripts for worktrees removed since.
const WORKTREES = new Map();
for (const block of git(['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/)) {
  const name = block.match(/^worktree .*[\\/]\.claude[\\/]worktrees[\\/]([^\\/\r\n]+)$/m)?.[1];
  const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
  if (name && branch) WORKTREES.set(name, branch.trim());
}

// A subagent dispatched with worktree isolation works in `.claude/worktrees/agent-<id>`, removed
// afterwards; its meta file names the worktree, and its description (which starts with the
// step id) is a far better label than the generated branch name.
function learnAgentWorktrees() {
  for (const dir of fs.readdirSync(PROJECTS).filter((d) => d.startsWith(PREFIX))) {
    for (const session of fs.readdirSync(path.join(PROJECTS, dir), { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const subDir = path.join(PROJECTS, dir, session.name, 'subagents');
      if (!fs.existsSync(subDir)) continue;
      for (const f of fs.readdirSync(subDir).filter((x) => x.endsWith('.meta.json'))) {
        let meta;
        try {
          meta = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8'));
        } catch (err) {
          throw new Error(`Cannot parse subagent metadata ${path.join(subDir, f)}: ${err.message}`);
        }
        // Some isolated agents' meta files omit the path; their worktree is still agent-<id>.
        const name = meta.worktreePath ? path.basename(meta.worktreePath.replace(/[\\/]+$/, '')) : f.replace('.meta.json', '');
        if (!WORKTREES.has(name)) WORKTREES.set(name, meta.description ?? meta.worktreeBranch ?? name);
      }
    }
  }
}
learnAgentWorktrees();

function learnWorktrees(command) {
  for (const add of command.match(WT_ADD_RE) ?? []) {
    const name = [...add.matchAll(WT_RE)][0]?.[1];
    const branch = add.match(/\s-[bB]\s+([A-Za-z0-9._/-]+)/)?.[1];
    if (name && branch && !WORKTREES.has(name)) WORKTREES.set(name, branch);
  }
}

// A worktree name as written in a command or path: trailing dots are sentence punctuation, and
// a glob like `agent-ae03*` stands for the one worktree it prefixes.
function branchOfWorktree(written) {
  const name = written.replace(/\.+$/, '');
  if (WORKTREES.has(name)) return WORKTREES.get(name);
  const prefixed = [...WORKTREES.keys()].filter((n) => n.startsWith(name));
  return prefixed.length === 1 ? WORKTREES.get(prefixed[0]) : name;
}

// The branch a line points at, or null. `merged` is true for a merge run in the main checkout.
function markersOf(j) {
  if (j.gitBranch && !MAIN_BRANCHES.has(j.gitBranch)) return { branch: j.gitBranch, merged: false };
  const content = Array.isArray(j.message?.content) ? j.message.content : [];
  const hits = new Map();
  let created = null;
  let merged = false;
  for (const block of content) {
    if (block?.type !== 'tool_use' || !block.input) continue;
    const command = typeof block.input.command === 'string' ? block.input.command : '';
    if (command) learnWorktrees(command);
    for (const m of JSON.stringify(block.input).matchAll(WT_RE)) {
      const branch = branchOfWorktree(m[1]);
      hits.set(branch, (hits.get(branch) ?? 0) + 1);
    }
    for (const m of command.matchAll(NEW_BRANCH_RE)) created = m[1];
    if (MERGE_RE.test(command) && !command.match(WT_RE)) merged = true;
  }
  if (created) return { branch: created, merged };
  const top = [...hits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { branch: top, merged };
}

// One assistant message can be written as several transcript lines; the last carries the
// final usage, so key by message id and keep the last. `spawns` maps each tool_use id to the
// branch current when it was issued, so a subagent can inherit its dispatcher's branch.
function readCalls(file, start) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read transcript ${file}: ${err.code ?? err.message}`);
  }
  const byId = new Map();
  const spawns = new Map();
  let current = start;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      // A partially written last line (session still open) is expected; skip it.
      continue;
    }
    const { branch, merged } = markersOf(j);
    if (branch) current = branch;
    const m = j.message;
    if (Array.isArray(m?.content)) {
      for (const block of m.content) if (block?.type === 'tool_use' && block.id) spawns.set(block.id, current);
    }
    if (m?.usage && m.id && m.model && m.model !== '<synthetic>') {
      const u = m.usage;
      byId.set(m.id, {
        branch: current,
        at: j.timestamp ?? '',
        model: m.model,
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cw5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
        cw1h: u.cache_creation?.ephemeral_1h_input_tokens ?? (u.cache_creation ? 0 : u.cache_creation_input_tokens ?? 0),
        output: u.output_tokens ?? 0,
      });
    }
    if (merged) current = MAIN;
  }
  return { calls: [...byId.values()], spawns };
}

// ---- Pricing and aggregation -------------------------------------------------------------------

function priceOf(model, u) {
  const p = PRICES[modelKey(model)];
  if (!p) return null;
  const prompt = u.input + u.cacheRead + u.cw5m + u.cw1h;
  const r = p.long && prompt > p.long.over ? { ...p, ...p.long } : p;
  return {
    input: (u.input * r.input) / 1e6,
    write: ((u.cw5m * 1.25 + u.cw1h * 2) * r.input) / 1e6,
    read: (u.cacheRead * r.cacheRead) / 1e6,
    output: (u.output * r.output) / 1e6,
  };
}

function emptyAgg() {
  return {
    cost: 0, write: 0, read: 0, requests: 0, mainCost: 0, mainRequests: 0, mainContext: 0,
    cold: 0, coldCost: 0, byRole: {}, unpriced: new Set(), sessions: new Set(), first: '', last: '',
  };
}

function add(agg, call, role, session) {
  const c = priceOf(call.model, call);
  if (!c) { agg.unpriced.add(call.model); return; }
  const cost = c.input + c.write + c.read + c.output;
  const context = call.input + call.cacheRead + call.cw5m + call.cw1h;
  agg.cost += cost;
  agg.write += c.write;
  agg.read += c.read;
  agg.requests += 1;
  agg.sessions.add(session);
  if (role === 'main') {
    agg.mainCost += cost;
    agg.mainRequests += 1;
    agg.mainContext += context;
    if (context >= COLD_MIN && call.cw5m + call.cw1h >= context / 2) { agg.cold += 1; agg.coldCost += c.write; }
  }
  const key = `${role}:${modelKey(call.model).replace('claude-', '')}`;
  agg.byRole[key] = (agg.byRole[key] ?? 0) + cost;
  if (call.at && (!agg.first || call.at < agg.first)) agg.first = call.at;
  if (call.at > agg.last) agg.last = call.at;
}

// ---- Lines changed -----------------------------------------------------------------------------
// Every commit on main's first-parent line, with its lines added + deleted against its first
// parent (so a merge counts what its branch brought in). Lockfiles are left out. A merge's
// branch comes from its second parent when a live branch still points there, else from a
// "Merge branch 'x'" subject; its step from a "(#id" in the subject.

const SKIP_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

function commitsOnMain() {
  const out = git(['log', 'main', '--first-parent', '--diff-merges=first-parent', '--numstat', '--format=@@%H%x09%P%x09%cI%x09%s']);
  const commits = [];
  for (const chunk of out.split('@@').slice(1)) {
    const [head, ...rest] = chunk.split('\n');
    const [sha, parents, at, subject] = head.split('\t');
    let lines = 0;
    for (const row of rest) {
      const m = row.match(/^(\d+)\t(\d+)\t(.+)$/);
      if (m && !SKIP_FILES.test(m[3].trim())) lines += Number(m[1]) + Number(m[2]);
    }
    const ps = parents.split(' ').filter(Boolean);
    // A direct commit on main (spec, plan, ruling) belongs to (main).
    commits.push({ sha, second: ps[1] ?? null, at: Date.parse(at), subject: subject ?? '', lines, branch: ps[1] ? null : MAIN });
  }
  const merges = commits.filter((c) => c.second);
  if (merges.length) {
    const names = git(['name-rev', '--name-only', '--refs=refs/heads/*', ...merges.map((c) => c.second)]).trim().split(/\r?\n/);
    merges.forEach((c, i) => {
      const name = names[i]?.trim();
      c.branch = name && !/[~^]/.test(name) && name !== 'undefined' ? name : c.subject.match(/^Merge branch '([^']+)'/)?.[1] ?? null;
    });
  }
  return commits;
}

// ---- Scan --------------------------------------------------------------------------------------

const dirs = fs.readdirSync(PROJECTS).filter((d) => d.startsWith(PREFIX));
if (!dirs.length) {
  console.error(`No transcript directories matching ${path.join(PROJECTS, PREFIX)}*. Is this the InProgress repo's Claude Code project?`);
  process.exit(1);
}

const groups = new Map();
const group = (key) => groups.get(key) ?? groups.set(key, emptyAgg()).get(key);
// Each session's first and last counted request, for the lines that landed while it ran.
const spans = new Map();
const take = (call, id) => {
  if (SINCE && call.at < SINCE) return false;
  if (!call.at) return true;
  const s = spans.get(id) ?? spans.set(id, { first: call.at, last: call.at }).get(id);
  if (call.at < s.first) s.first = call.at;
  if (call.at > s.last) s.last = call.at;
  return true;
};

for (const dir of dirs) {
  for (const name of fs.readdirSync(path.join(PROJECTS, dir)).filter((f) => f.endsWith('.jsonl'))) {
    const id = name.replace('.jsonl', '').slice(0, 8);
    if (EXCLUDE.some((p) => id.startsWith(p))) continue;
    if (ONLY.length && !ONLY.some((p) => id.startsWith(p))) continue;
    const main = readCalls(path.join(PROJECTS, dir, name), MAIN);
    for (const c of main.calls) if (take(c, id)) add(group(BY === 'session' ? id : c.branch), c, 'main', id);
    const subDir = path.join(PROJECTS, dir, name.replace('.jsonl', ''), 'subagents');
    if (!fs.existsSync(subDir)) continue;
    for (const sub of fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl'))) {
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(subDir, sub.replace('.jsonl', '.meta.json')), 'utf8'));
      } catch {
        // Older subagents have no meta file; they start from (main).
      }
      const s = readCalls(path.join(subDir, sub), main.spawns.get(meta.toolUseId) ?? MAIN);
      for (const c of s.calls) if (take(c, id)) add(group(BY === 'session' ? id : c.branch), c, 'sub', id);
    }
  }
}

// ---- Report ------------------------------------------------------------------------------------

const commits = commitsOnMain();
const usd = (n) => `$${n.toFixed(2)}`;
const k = (n) => `${Math.round(n / 1000)}k`;
const pct = (part, whole) => `${Math.round((part / Math.max(whole, 1e-9)) * 100)}%`;
const split = (g) => Object.entries(g.byRole).sort((a, b) => b[1] - a[1]).filter(([, v]) => v / g.cost >= 0.01)
  .map(([key, v]) => `${key} ${pct(v, g.cost)}`).join(', ');
const per1k = (cost, lines) => (lines ? usd((cost / lines) * 1000) : '-');

const within = (span) => commits.filter((c) => c.at >= Date.parse(span.first) && c.at <= Date.parse(span.last));
const sum = (cs) => cs.reduce((n, c) => n + c.lines, 0);

// A session is credited with what landed on main while it ran (overlapping sessions share
// credit). A branch is credited with its merges; (main) with direct commits on main.
function linesFor(key) {
  if (BY === 'session') return { lines: sum(within(spans.get(key))), step: '' };
  const hit = [...landed.values()].filter((c) => c.branch === key);
  const steps = [...new Set(hit.map((c) => c.subject.match(/\(#(\d+)/)?.[1]).filter(Boolean))].map((s) => `#${s}`);
  return { lines: sum(hit), step: steps.join(',') || key.match(/^#\d+/)?.[0] || '' };
}

const rows = [...groups.entries()].filter(([, g]) => g.requests).sort((a, b) => b[1].cost - a[1].cost);
const total = emptyAgg();
// The all-in figure, in both modes: every commit that landed on main while any counted session ran.
const landed = new Map();
for (const span of spans.values()) for (const c of within(span)) landed.set(c.sha, c);
const totalLines = sum([...landed.values()]);

if (BY === 'session') {
  console.log('session   from         to           req   cost      main%  main ctx  cold rw (n, $)   lines  $/1k lines  split');
} else {
  console.log('branch                              step        sess   req   cost      main%  main ctx  lines  $/1k lines  split');
}
for (const [key, g] of rows) {
  const { lines, step } = linesFor(key);
  for (const f of ['cost', 'write', 'read', 'requests', 'mainCost', 'mainRequests', 'mainContext', 'cold', 'coldCost']) total[f] += g[f];
  for (const [r, v] of Object.entries(g.byRole)) total.byRole[r] = (total.byRole[r] ?? 0) + v;
  for (const s of g.sessions) total.sessions.add(s);
  for (const m of g.unpriced) total.unpriced.add(m);
  const ctx = g.mainRequests ? k(g.mainContext / g.mainRequests) : '-';
  const unpriced = g.unpriced.size ? `  (unpriced: ${[...g.unpriced].join(', ')})` : '';
  if (BY === 'session') {
    console.log(
      `${key.padEnd(9)} ${g.first.slice(0, 16).replace('T', ' ').slice(5).padEnd(12)} ${g.last.slice(0, 16).replace('T', ' ').slice(5).padEnd(12)} ` +
      `${String(g.requests).padStart(4)}  ${usd(g.cost).padEnd(9)} ${pct(g.mainCost, g.cost).padStart(5)}  ${ctx.padStart(8)}  ` +
      `${`${g.cold}, ${usd(g.coldCost)}`.padEnd(15)}  ${String(lines || '-').padStart(5)}  ${per1k(g.cost, lines).padStart(10)}  ${split(g)}${unpriced}`,
    );
  } else {
    console.log(
      `${key.slice(0, 35).padEnd(35)} ${(step || '-').slice(0, 11).padEnd(11)} ${String(g.sessions.size).padStart(4)}  ${String(g.requests).padStart(4)}  ` +
      `${usd(g.cost).padEnd(9)} ${pct(g.mainCost, g.cost).padStart(5)}  ${ctx.padStart(8)}  ${String(lines || '-').padStart(5)}  ` +
      `${per1k(g.cost, lines).padStart(10)}  ${split(g)}${unpriced}`,
    );
  }
}

const totalCtx = total.mainRequests ? k(total.mainContext / total.mainRequests) : '-';
console.log(
  `\nall: ${total.sessions.size} sessions, ${total.requests} requests, ${usd(total.cost)}; ` +
  `main ${pct(total.mainCost, total.cost)} of cost at ${totalCtx} average context; ` +
  `cache writes ${usd(total.write)}, cache reads ${usd(total.read)}; ` +
  `${total.cold} cold re-writes costing ${usd(total.coldCost)}; ` +
  `${totalLines} lines landed on main, ${per1k(total.cost, totalLines)} per 1k.`,
);
console.log(`split: ${split(total)}`);
if (total.unpriced.size) console.log(`unpriced models (left out of every figure): ${[...total.unpriced].join(', ')}`);
