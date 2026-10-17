// npm run deploy [--full]: test a fresh build in .build (smoke and e2e only when the change needs them; --full runs
// everything), make it live, restart the server on it.
// npm run rollback: swap the live build with the previous one and restart.
// The live dist/ and web/dist/ are what the installed hooks, the scribe's MCP server and the server run from; they
// are only ever replaced whole, by renames (scripts/deploy-lib.mjs), after every check has passed.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, buildLabel as label, lockHeldMessage, lockTakenOverMessage, promote, restartCheck, suitesFor, swapWithPrev } from './deploy-lib.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const buildRoot = join(repo, '.build');
const prev = join(repo, '.deploy', 'prev');
const rollback = process.argv.includes('--rollback');

const step = (text) => console.log(`\n▸ ${text}`);
const npm = (script) => execFileSync('npm', ['run', script], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
const cli = (args, opts = {}) => spawnSync(process.execPath, [join(repo, 'dist', 'cli', 'main.js'), ...args], { cwd: repo, stdio: 'inherit', ...opts });
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** A git command's trimmed output, or undefined when it fails. */
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};

/** Paths changed (committed, staged, unstaged or untracked) since a commit, or null if git can't tell. */
function changedSince(sha) {
  if (!sha || sha === 'unknown') return null;
  const diff = git(['diff', '--name-only', sha]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (diff === undefined || untracked === undefined) return null;
  return [...diff.split('\n'), ...untracked.split('\n')].filter(Boolean);
}

/** What GET /api/health gave: `{ status, text }` when it answered, `{ error }` when it did not. */
async function health() {
  const port = Number(process.env.INPROGRESS_PORT) || 4317;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return { status: res.status, text: await res.text() };
  } catch (error) {
    return { error };
  }
}

/**
 * Stops the old server and starts one on the live build. `ok` when it answers with that build; otherwise `saw` says
 * what the check got instead.
 */
async function restart() {
  if (existsSync(join(repo, 'dist', 'cli', 'main.js'))) cli(['stop']);
  const started = cli(['start']);
  if (started.status !== 0) return { ok: false, saw: `\`start\` exited with ${started.status ?? started.signal ?? started.error?.message}` };
  const saw = restartCheck(readJson(join(repo, 'dist', 'build.json')), await health());
  return { ok: !saw, saw };
}

// One deploy or rollback at a time (scripts/deploy-lib.mjs acquireLock): a second one refuses before it touches anything.
const lockFile = join(repo, '.deploy', 'lock');
const lock = acquireLock({
  file: lockFile,
  info: { kind: rollback ? 'rollback' : 'deploy', sha: git(['rev-parse', '--short', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), startedAt: new Date().toISOString() },
});
if (lock.holder) {
  console.error(lockHeldMessage(lock.holder, lockFile));
  process.exit(1);
}
process.on('exit', lock.release);
if (lock.tookOver) console.log(lockTakenOverMessage(lock.tookOver));

if (rollback) {
  step('Rolling back to the previous build');
  swapWithPrev({ repo, prev });
  const back = await restart();
  if (!back.ok) {
    console.error('The previous build did not start cleanly: run `npm run rollback` again to return to the newer one.');
    console.error(`Restart check: ${back.saw}`);
    process.exit(1);
  }
  console.log(`\nRolled back. Live: ${label(readJson(join(repo, 'dist', 'build.json')))}. Run \`npm run rollback\` again to return.`);
  process.exit(0);
}

// The slower suites run only for changes they cover (scripts/deploy-lib.mjs suitesFor); --full runs everything.
const deployed = readJson(join(repo, 'dist', 'build.json'));
const changed = process.argv.includes('--full') ? null : changedSince(deployed?.sha);
const suites = suitesFor(changed);
const since = deployed?.sha ? `since ${deployed.sha}` : '';

step('Type checks');
npm('typecheck');
step('Unit tests');
npm('test');
if (suites.smoke) {
  step('Smoke tests against a fresh build in .build');
  npm('test:smoke');
} else console.log(`\n▸ Smoke tests skipped: no hook, CLI, MCP, server or kit changes ${since}`);
if (suites.e2e) {
  step('Browser tests against a full build in .build');
  npm('test:e2e');
} else {
  step(`Full build in .build (browser tests skipped: no UI, core or server changes ${since})`);
  npm('build');
}

const candidate = readJson(join(buildRoot, 'dist', 'build.json'));
step(`Making ${label(candidate)} live`);
promote({ repo, from: buildRoot, prev });

// The kit (hooks, agent, skill) only needs reinstalling when what install would write has changed.
const check = cli(['claude-check']);
if (check.status === 2) {
  step('Updating the installed Claude kit');
  if (cli(['claude-install']).status !== 0) console.error('claude-install failed: the new build is live, but run `npm run claude:install` by hand.');
}

step('Restarting the server on the new build');
const restarted = await restart();
if (!restarted.ok) {
  console.error('\nThe new build did not start cleanly: rolling back.');
  console.error(`Restart check: ${restarted.saw}`);
  swapWithPrev({ repo, prev });
  const back = await restart();
  if (!back.ok) console.error(`The previous build did not start cleanly either. Restart check: ${back.saw}`);
  process.exit(1);
}
console.log(`\nDeployed ${label(candidate)}. The previous build is kept: \`npm run rollback\` swaps back.`);
