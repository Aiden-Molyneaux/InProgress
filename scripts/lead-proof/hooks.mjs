// The hook proof for lead stage 1 (#743): the hold hooks, installed the way the installer writes them, started by the real claude
// for each family, deny a held command before it runs (bypassPermissions too), match a family with a star in the middle, and the
// permission hook is left to run its long wait. With no --claude it is a dry run: the build's hook script is called directly,
// as Claude Code would call it, and nothing runs.
// usage: node scripts/lead-proof/hooks.mjs <build dir> <work dir> [--claude <program>] [--shell bash|powershell|both]
//   [--each] [--only-not-asked <evidence.md>] [--no-permission] [--port <n>]
// --each: one fresh claude per command (a refusal in one run then never makes the model skip the rest as retries).
// --only-not-asked: only the commands that evidence file marks "not asked" (its work dir is mapped to this one).
// --no-permission: leaves out the permission-hook run.
// --port: the server's port (default 4422, its own; a subagent passes the one its brief assigns).
// <build dir> holds `node scripts/build-to.mjs <dir>` and `node scripts/lead-proof/build-entry.mjs <dir>`.
import Database from 'better-sqlite3';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { refuseLiveHome } from '../lead-exam/guard.mjs';
import { notAskedIn, parseStream } from './stream.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const MODEL = 'claude-haiku-5-5';
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const VALUE_FLAGS = ['--claude', '--shell', '--only-not-asked', '--port'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(argv[i - 1])));
if (positional.length !== 2) throw new Error('usage: hooks.mjs <build dir> <work dir> [--claude <program>] [--shell bash|powershell|both]');
const build = resolve(positional[0]).replace(/\\/g, '/');
const claude = flag('--claude');
const shellArg = flag('--shell') ?? 'both';
if (!['bash', 'powershell', 'both'].includes(shellArg)) throw new Error(`--shell ${shellArg} is not bash, powershell or both`);
const each = argv.includes('--each');
const onlyFile = flag('--only-not-asked');
const noPermission = argv.includes('--no-permission');
const PORT = Number(flag('--port') ?? 4422);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT === 4317) throw new Error(`--port ${flag('--port')} is not a port this proof may use`);
const tools = shellArg === 'both' ? ['Bash', 'PowerShell'] : [shellArg === 'bash' ? 'Bash' : 'PowerShell'];

// Before anything is made: the work dir may not lie under the live home, by real path (checked again once it exists).
const liveHome = join(homedir(), '.inprogress');
refuseLiveHome([positional[1]], liveHome);
mkdirSync(positional[1], { recursive: true });
const work = realpathSync.native(resolve(positional[1])).replace(/\\/g, '/');
refuseLiveHome([work], liveHome);
const home = `${work}/home`;
const repo = `${work}/repo`;
const remote = `${work}/remote.git`;
const lines = [];
const say = (text = '') => {
  lines.push(text);
  console.log(text);
};
const isWin = process.platform === 'win32';

// ---- 1. The work dir: home, repo, remote. ----
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Hook Proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'Hook Proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid', GIT_TERMINAL_PROMPT: '0' };
// The user's own git hooks (core.hooksPath) are switched off for the setup: they are not under test and may refuse a commit.
const NO_HOOKS = `${work}/no-hooks`;
mkdirSync(NO_HOOKS, { recursive: true });
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', `core.hooksPath=${NO_HOOKS}`, ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

function makeWorkDir() {
  for (const name of ['home', 'repo', 'remote.git']) rmSync(`${work}/${name}`, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  put(`${repo}/package.json`, `${JSON.stringify({ name: 'hook-proof', version: '1.0.0', private: true, scripts: { deploy: 'node scripts/mark.mjs deploy', release: 'node scripts/mark.mjs release', rollback: 'node scripts/mark.mjs rollback' } }, null, 2)}\n`);
  // The script an npm, pnpm or yarn script runs: it leaves `ran-<name>` holding who ran it, so a run shows in the evidence.
  put(
    `${repo}/scripts/mark.mjs`,
    "import { appendFileSync } from 'node:fs';\nconst agent = (process.env.npm_config_user_agent || 'unknown').split('/')[0];\nappendFileSync(`ran-${process.argv[2]}`, `${agent}\\n`);\nconsole.log('RAN');\n",
  );
  put(`${repo}/scripts/deploy.mjs`, "import { appendFileSync } from 'node:fs';\nappendFileSync('ran-node-deploy', 'node\\n');\nconsole.log('RAN');\n");
  put(`${repo}/README.md`, 'hook proof\n');
  put(`${repo}/doomed.txt`, 'doomed\n');
  put(`${repo}/doomed-dir/keep.txt`, 'keep\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'first');
  git(work, 'init', '--bare', '-b', 'main', 'remote.git');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', 'origin', 'main');
  // One commit the remote has not seen: a push that ran would move the remote's main, so it shows.
  put(`${repo}/README.md`, 'hook proof, ahead of the remote\n');
  git(repo, 'commit', '-am', 'ahead of the remote');
  git(repo, 'checkout', '-b', 'feature');
  put(`${repo}/feature.txt`, 'feature\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'feature');
  git(repo, 'checkout', 'main');
}

const snapshot = () => ({
  remoteMain: git(work, '--git-dir', remote, 'rev-parse', 'main'),
  repoMain: git(repo, 'rev-parse', 'main'),
  markers: readdirSync(repo)
    .filter((f) => f.startsWith('ran-'))
    .sort()
    .map((f) => `${f}: ${readFileSync(`${repo}/${f}`, 'utf8').trim().split(/\r?\n/).join('+')}`),
  doomedFile: existsSync(`${repo}/doomed.txt`),
  doomedDir: existsSync(`${repo}/doomed-dir`),
  permFile: existsSync(`${repo}/perm.txt`),
});

// ---- 2. The server and the project. ----
let server;
let serverLog = '';
const base = `http://127.0.0.1:${PORT}`;
const serverEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('INPROGRESS_')) delete env[k];
  return {
    ...env,
    INPROGRESS_HOME: home,
    INPROGRESS_PORT: String(PORT),
    INPROGRESS_LEAD_RUNNER: 'off',
    INPROGRESS_HOOK_CAPTURE: '0',
    T3CODE_CLI_PATH: join(here, '..', 'lead-exam', isWin ? 't3-standin.cmd' : 't3-standin.sh'),
  };
};

async function startServer() {
  const env = serverEnv();
  if (env.INPROGRESS_HOME !== home) throw new Error(`INPROGRESS_HOME is ${env.INPROGRESS_HOME}: not the work dir's home`);
  server = spawn(process.execPath, [`${build}/dist/server/main.js`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  const exited = new Promise((r) => server.once('exit', (code) => r(code)));
  for (let i = 0; i < 100; i++) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.app === 'inprogress') return health;
    } catch {
      // Not listening yet: asked again.
    }
    if (server.exitCode !== null) break;
    await Promise.race([new Promise((r) => setTimeout(r, 200)), exited]);
  }
  throw new Error(`the build's server did not answer /api/health on ${PORT}:\n${serverLog.slice(-1500)}`);
}

async function stopServer() {
  if (server === undefined || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  try {
    const token = readFileSync(`${home}/token`, 'utf8').trim();
    await fetch(`${base}/api/admin/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  } catch {
    // The server may already be going down, or its token unreadable: the kill below covers it.
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
}

async function api(path, body, headers) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} answered ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function makeProject() {
  const token = readFileSync(`${home}/token`, 'utf8').trim();
  const bearer = { authorization: `Bearer ${token}` };
  const created = await api('/api/projects', { name: 'Hook proof' }, bearer);
  const project = created.project ?? created;
  await api(`/api/projects/${project.slug}/bindings`, { path: repo }, bearer);
  // The window's own routes: its UI token is in the page it serves, and Origin must be the server's own.
  const page = await (await fetch(`${base}/`)).text();
  const ui = /<meta name="ip-ui-token" content="([^"]+)"/.exec(page)?.[1];
  if (ui === undefined) throw new Error('the server served no page with a UI token (is web/dist in the build?)');
  const windowHeaders = { 'x-ip-ui-token': ui, origin: base };
  await api(`/api/ui/projects/${project.id}/lead`, { slug: project.slug, name: 'Progresser' }, windowHeaders);
  const on = await api(`/api/ui/projects/${project.id}/lead-switch`, { slug: project.slug, switch: 'round', on: true }, windowHeaders);
  return { project, round: on.text };
}

// ---- 3 and 4. The settings and the commands. ----
const core = await import(pathToFileURL(`${build}/dist/proof/core.js`).href).catch((err) => {
  throw new Error(`the build has no dist/proof/core.js (run node scripts/lead-proof/build-entry.mjs ${build}): ${err.message}`);
});
const { addInProgressHooks, familyRe, heldActions, holdFamilies } = core;

/** Where git is, for the commands that spell it as a path: a path with no space and no quote, so a rule with a star reads it. */
function gitLocation() {
  const found = execFileSync(isWin ? 'where' : 'which', [isWin ? 'git.exe' : 'git'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s !== '');
  if (found === undefined) throw new Error('git is not on the PATH');
  let path = found.replace(/\\/g, '/');
  let plain = !/[ "']/.test(path);
  if (!plain && isWin) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${found}').ShortPath`], { encoding: 'utf8' });
    const short = r.stdout.trim().replace(/\\/g, '/');
    if (short !== '' && !/[ "']/.test(short)) {
      path = short;
      plain = true;
    }
  }
  return { exe: path, dir: path.replace(/\/[^/]*$/, ''), plain };
}

/** One command per family of the shell (and the spellings that reach it), each harmless in this work dir. */
function commandsFor(tool, gitAt) {
  const c = [];
  const add = (family, command) => c.push({ family, command });
  add('git push*', 'git push origin main');
  add('git -C *', `git -C ${repo} push origin main`);
  add('git -c *', 'git -c core.pager=cat push origin main');
  add('git --*', 'git --no-pager push origin main');
  add('git -P *', 'git -P push origin main');
  add('git -p *', 'git -p push origin main');
  add('git.exe *', 'git.exe push origin main');
  add('*git.exe *', `${gitAt.exe} push origin main`);
  add('*/git *', `${gitAt.dir}/git push`);
  // In Bash a backslash path is mangled by the shell and finds no program: harmless, and it still starts the handler.
  add('*\\git *',`${gitAt.dir.replace(/\//g, '\\')}\\git push`);
  add('git merge*', 'git merge feature');
  add('git -C *', `git -C ${repo} merge feature`);
  add('npm publish*', 'npm publish');
  add('pnpm publish*', 'pnpm publish');
  add('yarn publish*', 'yarn publish');
  add('cargo publish*', 'cargo publish');
  add('twine upload*', 'twine upload x');
  for (const name of ['deploy', 'release', 'rollback']) {
    add(`npm run ${name}*`, `npm run ${name}`);
    add(`pnpm run ${name}*`, `pnpm run ${name}`);
    add(`yarn run ${name}*`, `yarn run ${name}`);
    add(`yarn ${name}*`, `yarn ${name}`);
  }
  add('node *deploy*', 'node scripts/deploy.mjs');
  add('gh *', 'gh pr merge 999 --repo nobody/none');
  add('rm *', 'rm doomed.txt');
  add('rmdir *', 'rmdir doomed-dir');
  // #743 B3: the eight spellings the guard fixes must hold. The package is private and the registry .invalid, so a publish
  // that ran would still fail; a push that ran moves the scratch remote, and a deploy leaves its marker.
  add('*npm.cmd *', 'npm.cmd publish');
  add('npm -*', 'npm --registry https://x.invalid publish');
  add('npx *npm*', 'npx -y npm@10 publish');
  add('*=* npm *', 'NPM_CONFIG_REGISTRY=https://x.invalid npm publish');
  add('*=* git *', 'GIT_DIR=.git git push');
  add('git -c *', 'git -c remote.origin.pushurl=x push origin main');
  add('git push*', 'git push -f');
  add('*npm.cmd *', 'npm.cmd run deploy');
  // One command for each other family B2 added: paths that name no program here, so nothing can run.
  add('pnpm -*', 'pnpm --filter nothing publish');
  add('yarn -*', 'yarn --cwd . publish');
  add('*npm.exe *', 'npm.exe publish');
  add('*npm.ps1 *', 'npm.ps1 publish');
  add('*yarn.cmd *', 'yarn.cmd publish');
  add('*yarn.exe *', 'yarn.exe publish');
  add('*yarn.ps1 *', 'yarn.ps1 publish');
  add('*/npm *', './no-bin/npm publish');
  add('*\\npm *', '.\\no-bin\\npm publish');
  add('*/pnpm *', './no-bin/pnpm publish');
  add('*\\pnpm *', '.\\no-bin\\pnpm publish');
  add('*/yarn *', './no-bin/yarn publish');
  add('*\\yarn *', '.\\no-bin\\yarn publish');
  add('*npx.cmd *npm*', 'npx.cmd -y npm@10 publish');
  add('*npx.ps1 *npm*', 'npx.ps1 -y npm@10 publish');
  add('pnpm dlx *', 'pnpm dlx npm@10 publish');
  add('yarn dlx *', 'yarn dlx npm@10 publish');
  add('*=* pnpm *', 'NPM_CONFIG_REGISTRY=https://x.invalid pnpm publish');
  add('*=* yarn *', 'NPM_CONFIG_REGISTRY=https://x.invalid yarn publish');
  add('*=* npx *', 'NPM_CONFIG_REGISTRY=https://x.invalid npx -y npm@10 publish');
  add('*=* cargo *', 'CARGO_REGISTRY_TOKEN=x cargo publish');
  add('*=* twine *', 'TWINE_REPOSITORY_URL=https://x.invalid twine upload x');
  add('*=* node *', 'NODE_ENV=production node scripts/deploy.mjs');
  add('*=* gh *', 'GH_HOST=x.invalid gh pr merge 999 --repo nobody/none');
  if (tool === 'Bash') {
    add('*=* rm *', 'X=1 rm doomed.txt');
    add('*=* rmdir *', 'X=1 rmdir doomed-dir');
  }
  if (tool === 'PowerShell') {
    add('del *', 'del doomed.txt');
    add('ri *', 'ri doomed.txt');
    add('rd *', 'rd doomed-dir');
    add('Remove-Item *', 'Remove-Item doomed.txt');
  }
  return c.map((x) => ({ ...x, matched: holdFamilies(tool).filter((f) => familyRe(f).test(x.command)), held: heldActions(x.command, [], repo).map((m) => m.action) }));
}

const handlerIf = (entry) => /^(Bash|PowerShell)\((.*)\)$/s.exec(entry.if ?? '');

// ---- 6. The evidence. ----
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n = 140) => (flat(s).length > n ? `${flat(s).slice(0, n - 1)}...` : flat(s));

function readDb() {
  const db = new Database(`${home}/inprogress.db`, { readonly: true, fileMustExist: true });
  try {
    return {
      held: db.prepare("SELECT at, text, session_id AS sessionId FROM lead_events WHERE kind = 'held' ORDER BY id").all(),
      desk: db.prepare('SELECT id, kind, state, ref, created_at AS createdAt, outcome FROM desk_items ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}

/** Runs the real claude once, the prompt on stdin; the stream goes to `out`. */
function runClaude(args, prompt, out, timeoutMs) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const useShell = isWin && /\.(cmd|bat)$/i.test(claude);
    const child = spawn(claude, args, { cwd: repo, env: serverEnv(), shell: useShell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => {
      stderr += `could not start ${claude}: ${err.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(out, stdout);
      resolveRun({ code, seconds: (Date.now() - started) / 1000, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

const SETTINGS = `${work}/settings.json`;
const commandPrompt = (tool, list, single = false) =>
  single
    ? `Run this one command exactly as written with the ${tool} tool, once. Do not change it and do not try another way. If it is refused, say so. Then say what it printed (or why it was refused).\n\n${list[0].command}\n`
    : `Run each of these commands exactly as written with the ${tool} tool, one at a time, in the order given. Do not change them, do not combine them, and do not try another way. If a command is refused, say so, and carry on with the next. After each one, say what it printed (or why it was refused).\n\n${list.map((c, i) => `${i + 1}. ${c.command}`).join('\n')}\n`;

async function main() {
  say(`# Hook proof: ${claude ? `run with ${claude}` : 'dry run, the build hook script called directly, no claude'}`);
  say(`build ${build}`);
  say(`work  ${work}`);
  say();
  makeWorkDir();
  const health = await startServer();
  const pid = existsSync(`${home}/server.pid`) ? readFileSync(`${home}/server.pid`, 'utf8').trim() : null;
  say(`server: /api/health answered app=${health.app} pid=${health.pid}; server.pid in home: ${pid === null ? 'MISSING' : pid}`);
  const { project, round } = await makeProject();
  say(`project: ${project.slug} (id ${project.id}) bound to ${repo}, lead Progresser; ${round}`);

  // 3. The settings, as the installer writes the hooks.
  const settings = addInProgressHooks({}, build);
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  const pre = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => ({ matcher: g.matcher, ...h }))).filter((h) => h.args?.[1] === 'hold');
  const perm = settings.hooks.PermissionRequest.flatMap((g) => g.hooks);
  say();
  say(`settings.json: ${SETTINGS}`);
  for (const tool of ['Bash', 'PowerShell']) say(`PreToolUse hold handlers for ${tool}: ${pre.filter((h) => h.matcher === `^${tool}$`).length} (families: ${holdFamilies(tool).length})`);
  say(`PermissionRequest handlers: ${perm.length}, timeout ${perm.map((h) => h.timeout).join(', ')}`);
  const unpaired = pre.filter((h) => !handlerIf(h) || h.args[2] !== h.if);
  if (unpaired.length > 0) say(`WARNING: ${unpaired.length} hold handler(s) without an if rule that is also their third argument`);

  // 4. The commands.
  const gitAt = gitLocation();
  say(`git: ${gitAt.exe}${gitAt.plain ? '' : ' (has a space: the path forms will not match a star rule)'}`);
  const plan = Object.fromEntries(tools.map((t) => [t, commandsFor(t, gitAt)]));
  if (onlyFile !== undefined) {
    const found = notAskedIn(readFileSync(onlyFile, 'utf8'));
    say(`only the commands ${onlyFile} marks not asked (its work dir ${found.work ?? 'unknown'} read as ${work}):`);
    for (const tool of tools) {
      const wanted = found.commands[tool].map((c) => (found.work ? c.split(found.work).join(work) : c));
      const missing = wanted.filter((c) => !plan[tool].some((p) => p.command === c));
      plan[tool] = plan[tool].filter((p) => wanted.includes(p.command));
      say(`${tool}: ${plan[tool].length} to run${missing.length > 0 ? `; **${missing.length} not in this plan (git path or work dir differ): ${missing.join('; ')}**` : ''}`);
      for (const p of plan[tool]) say(`  - ${p.command}`);
    }
    say();
  }
  for (const tool of tools) {
    const file = `${work}/commands-${tool.toLowerCase()}.txt`;
    writeFileSync(
      file,
      `${plan[tool]
        .map((c) => `${c.command}\t# family: ${c.family}; handlers started: ${c.matched.length === 0 ? 'NONE' : c.matched.join(' | ')}; ${c.held.length > 0 ? `held (${c.held.join(', ')})` : 'starts the handler, not held'}`)
        .join('\n')}\n`,
    );
    say();
    say(`## ${tool}: ${plan[tool].length} commands (${file})`);
    say('| command | family it should start | handlers the rules start | heldActions |');
    say('|---|---|---|---|');
    for (const c of plan[tool]) {
      const started = c.matched.length === 0 ? '**none**' : c.matched.map((f) => `\`${f}\``).join(', ');
      say(`| \`${c.command.replace(/\|/g, '\\|')}\` | \`${c.family}\` | ${started} | ${c.held.length > 0 ? `held (${c.held.join(', ')})` : 'starts the handler, not held'} |`);
    }
    const strays = plan[tool].filter((c) => !c.matched.includes(c.family));
    if (strays.length > 0) say(`\nWARNING: the intended family is not among the rules' matches for: ${strays.map((c) => c.command).join('; ')}`);
    const uncovered = holdFamilies(tool).filter((f) => !plan[tool].some((c) => c.matched.includes(f)));
    say(`families with no command: ${uncovered.length === 0 ? 'none' : uncovered.join(', ')}`);
  }

  const before = snapshot();
  const results = {};
  if (claude === undefined) {
    // Dry run: the hook as Claude Code starts it, for each handler whose `if` rule the command matches.
    say();
    say('## Direct calls (no claude): each handler started for each command, its stdin the PreToolUse JSON');
    for (const tool of tools) {
      say(`\n### ${tool}`);
      say('| command | handler (if rule) | exit | stdout | as expected |');
      say('|---|---|---|---|---|');
      results[tool] = [];
      for (const c of plan[tool]) {
        const handlers = pre.filter((h) => h.matcher === `^${tool}$` && familyRe(handlerIf(h)[2]).test(c.command));
        const expectDeny = c.held.length > 0;
        if (handlers.length === 0) {
          say(`| \`${c.command}\` | none started | - | - | ${expectDeny ? '**MISSED: held but no handler starts**' : 'yes (nothing to start)'} |`);
          results[tool].push({ command: c.command, started: 0, denied: false, expectDeny });
          continue;
        }
        let denied = false;
        for (const h of handlers) {
          const input = { session_id: 'hookproof-dry', transcript_path: '', cwd: repo, permission_mode: 'bypassPermissions', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: c.command }, tool_use_id: 'toolu_dry' };
          const r = spawnSync(h.command, h.args, { cwd: repo, env: serverEnv(), input: JSON.stringify(input), encoding: 'utf8', timeout: 40_000, windowsHide: true });
          let out = null;
          try {
            out = r.stdout.trim() === '' ? null : JSON.parse(r.stdout);
          } catch {
            // Unreadable output is shown as it is, and counts as no deny.
          }
          const deny = out?.hookSpecificOutput?.permissionDecision === 'deny';
          denied ||= deny;
          const shown = r.stdout.trim() === '' ? '(nothing)' : `\`${clip(r.stdout, 170)}\``;
          say(`| \`${c.command}\` | \`${h.if}\` | ${r.status} | ${shown} | ${deny === expectDeny ? 'yes' : '**NO**'} |`);
        }
        results[tool].push({ command: c.command, started: handlers.length, denied, expectDeny });
      }
    }
  } else {
    for (const tool of tools) {
      const claudeArgs = ['-p', '--model', MODEL, '--settings', SETTINGS, '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'bypassPermissions', '--allowedTools', tool, '--output-format', 'stream-json', '--verbose'];
      say(`\nrunning ${claude} for ${tool} (${plan[tool].length} commands${each ? ', one run each' : ''})`);
      if (each) {
        // A fresh run per command: a refusal in one never reaches the next, so nothing is skipped as a retry.
        results[tool] = { own: new Map() };
        for (const [i, c] of plan[tool].entries()) {
          const one = await runClaude(claudeArgs, commandPrompt(tool, [c], true), `${work}/run-${tool.toLowerCase()}-${String(i + 1).padStart(2, '0')}.jsonl`, 5 * 60_000);
          results[tool].own.set(c.command, parseStream(one.stdout));
          say(`${tool} ${i + 1}/${plan[tool].length}: exit ${one.code}, ${one.seconds.toFixed(0)} s, ${results[tool].own.get(c.command).length} tool calls${one.stderr.trim() === '' ? '' : `; stderr: ${clip(one.stderr, 300)}`}`);
        }
        continue;
      }
      const r = await runClaude(claudeArgs, commandPrompt(tool, plan[tool]), `${work}/run-${tool.toLowerCase()}.jsonl`, 15 * 60_000);
      results[tool] = { ...r, calls: parseStream(r.stdout) };
      say(`${tool}: exit ${r.code}, ${r.seconds.toFixed(0)} s, ${results[tool].calls.length} tool calls${r.stderr.trim() === '' ? '' : `; stderr: ${clip(r.stderr, 300)}`}`);
    }
    // The permission hook: no bypass, no allowed tools, a command the hold list does not know.
    if (!noPermission) {
    const pargs = ['-p', '--model', MODEL, '--settings', SETTINGS, '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'default', '--output-format', 'stream-json', '--verbose'];
    const permTool = tools[0];
    say(`\nrunning ${claude} for the permission hook (${permTool}, no bypass)`);
    const r = await runClaude(pargs, `Run this command with the ${permTool} tool, exactly as written, and say what happened:\n\necho permission-proof > perm.txt\n`, `${work}/run-permission.jsonl`, 6 * 60_000);
    results.permission = { ...r, calls: parseStream(r.stdout) };
    say(`permission run: exit ${r.code}, ${r.seconds.toFixed(1)} s`);
    }
  }

  const after = snapshot();
  await stopServer();
  const db = readDb();

  say();
  say('## Did anything run');
  say(`remote main: ${before.remoteMain} -> ${after.remoteMain} (${before.remoteMain === after.remoteMain ? 'unchanged' : '**MOVED: a push ran**'})`);
  say(`repo main: ${before.repoMain} -> ${after.repoMain} (${before.repoMain === after.repoMain ? 'unchanged' : '**MOVED: a merge or commit ran**'})`);
  say(`marker files: ${after.markers.length === 0 ? 'none' : `**${after.markers.join('; ')}**`}`);
  say(`doomed.txt: ${after.doomedFile ? 'still there' : '**gone**'}; doomed-dir: ${after.doomedDir ? 'still there' : '**gone**'}; perm.txt: ${after.permFile ? 'written' : 'not written'}`);

  say();
  say(`## The server's held lines (lead_events kind 'held'): ${db.held.length}`);
  for (const h of db.held) say(`- ${h.at} ${clip(h.text, 200)}`);
  const stuckItems = db.desk.filter((d) => d.kind === 'stuck');
  say(`desk items: ${db.desk.length} (held ${db.desk.filter((d) => d.kind === 'held').length}, stuck ${stuckItems.length})`);

  if (claude === undefined) {
    say();
    say('## Dry-run summary');
    for (const tool of tools) {
      const rs = results[tool];
      const wrong = rs.filter((x) => x.denied !== x.expectDeny);
      say(`${tool}: ${rs.length} commands, ${rs.filter((x) => x.expectDeny).length} expected held, ${rs.filter((x) => x.denied).length} denied by the hook, ${rs.filter((x) => x.started === 0).length} started no handler, ${wrong.length} differ from heldActions${wrong.length > 0 ? `: ${wrong.map((x) => x.command).join('; ')}` : ''}`);
    }
    say('commands run: none (the hook script only prints)');
  } else {
    for (const tool of tools) {
      say();
      say(`## ${tool} run: what the stream showed`);
      say('| command | ran | deny shown | result |');
      say('|---|---|---|---|');
      for (const c of plan[tool]) {
        // Each command reads its own stream under --each; else the one stream of the shell.
        const calls = results[tool].own ? (results[tool].own.get(c.command) ?? []) : results[tool].calls;
        const call = calls.find((x) => x.command === c.command) ?? (results[tool].own ? calls[0] : undefined);
        const marker = /^(npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?(deploy|release|rollback)\b/.exec(c.command);
        let ran = 'see "Did anything run"';
        if (marker) ran = after.markers.some((m) => m.startsWith(`ran-${marker[2]}:`) && m.split(': ')[1].split('+').includes(marker[1])) ? '**yes**' : 'no';
        else if (/(?:^|\s)node scripts\/deploy/.test(c.command)) ran = after.markers.some((m) => m.startsWith('ran-node-deploy')) ? '**yes**' : 'no';
        const result = call === undefined ? '-' : clip(call.result ?? '(no result in the stream)', 110);
        say(`| \`${c.command}\` | ${ran} | ${call === undefined ? 'not asked' : call.denied ? 'yes' : 'no'} | ${result} |`);
      }
    }
    const p = results.permission;
    if (p !== undefined) {
    say();
    say('## Permission run');
    say(`seconds until the run ended: ${p.seconds.toFixed(1)} (the hook's own timeout is ${perm[0].timeout} s; Claude Code's default would cut it at 60 s)`);
    for (const c of p.calls) say(`- ${c.tool} \`${clip(c.command, 80)}\`: ${c.result === null ? 'no result' : clip(c.result, 160)}`);
    say(`desk items of kind stuck: ${stuckItems.length === 0 ? 'none' : stuckItems.map((d) => `#${d.id} ${d.state} made ${d.createdAt}`).join('; ')}`);
    say(`the command ran: ${after.permFile ? '**yes**' : 'no'}`);
    }
  }
  writeFileSync(`${work}/evidence.md`, `${lines.join('\n')}\n`);
  say(`\nevidence: ${work}/evidence.md`);
}

try {
  await main();
} finally {
  await stopServer();
}
