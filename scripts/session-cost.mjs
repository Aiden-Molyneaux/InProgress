#!/usr/bin/env node
// Prices InProgress dev work from Claude Code's own session transcripts, so sessions run under
// different routing setups can be compared. Read-only: scans every
// ~/.claude/projects/C--personal-InProgress* directory (the repo, its worktrees, .live-check)
// and runs read-only git commands against this repo.
//
//   node scripts/session-cost.mjs                          cost per branch, all time
//   node scripts/session-cost.mjs --by=session             cost per session
//   node scripts/session-cost.mjs --since=2026-10-09       only requests on or after that date
//   node scripts/session-cost.mjs --sessions=ab12cd34,ef56 only these sessions (full ids or their starts), e.g. a pilot's
//   node scripts/session-cost.mjs --exclude=c0dc2f4d       leave these sessions out (same)
//
// Costs are API-equivalent list prices (USD), not what a subscription bills. They exist to
// compare sessions and branches against each other, nothing else.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MAIN, agentWorktreeEntry, committedWithin, isCold, modelKey, nameMerges, parseMainLog, parseWorktreeList, priceOf,
  readCallsFromText,
} from './session-cost-lib.mjs';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const PREFIX = 'C--personal-InProgress';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// ---- Worktrees and transcripts -----------------------------------------------------------------
// How a request is attributed to a branch is in session-cost-lib.mjs. This part gives it the worktrees:
// the live ones from git and the isolated subagents' from their meta files. The lib adds the
// `git worktree add` commands it sees in transcripts, for worktrees removed since.

// Worktree directory name -> branch.
const WORKTREES = parseWorktreeList(git(['worktree', 'list', '--porcelain']));

function learnAgentWorktrees() {
  for (const dir of fs.readdirSync(PROJECTS).filter((d) => d.startsWith(PREFIX))) {
    for (const session of fs.readdirSync(path.join(PROJECTS, dir), { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const subDir = path.join(PROJECTS, dir, session.name, 'subagents');
      if (!fs.existsSync(subDir)) continue;
      for (const f of fs.readdirSync(subDir).filter((x) => x.endsWith('.meta.json'))) {
        let meta;
        try {
          meta = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8'));
        } catch {
          // A meta file still being written (a live session) is skipped, as the scan loop below does.
          continue;
        }
        const [name, label] = agentWorktreeEntry(f, meta);
        if (!WORKTREES.has(name)) WORKTREES.set(name, label);
      }
    }
  }
}
learnAgentWorktrees();

// The message ids priced so far in this run. A forked or resumed session's transcript starts with copies of the
// messages it was forked from; each is priced once, in whichever transcript is read first.
const SEEN = new Set();

function readCalls(file, start) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read transcript ${file}: ${err.code ?? err.message}`);
  }
  return readCallsFromText(raw, start, WORKTREES, SEEN);
}

// ---- Aggregation -------------------------------------------------------------------------------

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
    if (isCold(call)) { agg.cold += 1; agg.coldCost += c.write; }
  }
  const key = `${role}:${modelKey(call.model).replace('claude-', '')}`;
  agg.byRole[key] = (agg.byRole[key] ?? 0) + cost;
  if (call.at && (!agg.first || call.at < agg.first)) agg.first = call.at;
  if (call.at > agg.last) agg.last = call.at;
}

// ---- Lines changed -----------------------------------------------------------------------------
// Every commit on main's first-parent line, with its lines changed (parseMainLog); each merge is
// named from its second parent, by `git name-rev` (nameMerges).

function commitsOnMain() {
  const commits = parseMainLog(git(['log', 'main', '--first-parent', '--diff-merges=first-parent', '--numstat', '--format=%x00%H%x09%P%x09%cI%x09%s']));
  const merges = commits.filter((c) => c.second);
  if (merges.length) {
    nameMerges(commits, git(['name-rev', '--name-only', '--refs=refs/heads/*', ...merges.map((c) => c.second)]).trim().split(/\r?\n/));
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

// The --sessions entries that matched a transcript.
const matched = new Set();

for (const dir of dirs) {
  for (const name of fs.readdirSync(path.join(PROJECTS, dir)).filter((f) => f.endsWith('.jsonl'))) {
    // --sessions and --exclude match the whole session id, so a pasted full id works; the report names a session by
    // its first 8 characters.
    const fullId = name.replace('.jsonl', '');
    const id = fullId.slice(0, 8);
    const wanted = ONLY.filter((p) => fullId.startsWith(p));
    for (const p of wanted) matched.add(p);
    if (EXCLUDE.some((p) => fullId.startsWith(p))) continue;
    if (ONLY.length && !wanted.length) continue;
    const main = readCalls(path.join(PROJECTS, dir, name), MAIN);
    for (const c of main.calls) if (take(c, id)) add(group(BY === 'session' ? id : c.branch), c, 'main', id);
    const subDir = path.join(PROJECTS, dir, fullId, 'subagents');
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
// A --sessions entry that matches nothing is a typo or an id from another machine; without this the report would
// quietly leave that session out.
for (const p of ONLY) {
  if (!matched.has(p)) console.error(`warning: --sessions=${p} matches no session transcript. It takes a session id or the start of one.`);
}

// ---- Report ------------------------------------------------------------------------------------

const commits = commitsOnMain();
const usd = (n) => `$${n.toFixed(2)}`;
const k = (n) => `${Math.round(n / 1000)}k`;
const pct = (part, whole) => `${Math.round((part / Math.max(whole, 1e-9)) * 100)}%`;
const split = (g) => Object.entries(g.byRole).sort((a, b) => b[1] - a[1]).filter(([, v]) => v / g.cost >= 0.01)
  .map(([key, v]) => `${key} ${pct(v, g.cost)}`).join(', ');
const per1k = (cost, lines) => (lines ? usd((cost / lines) * 1000) : '-');

const within = (span) => committedWithin(commits, span);
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
