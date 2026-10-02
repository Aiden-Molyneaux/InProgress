// Builds InProgress into <root> (default .build) with the repo's layout: <root>/dist, <root>/web/dist, <root>/claude.
// Never touches the live dist/ and web/dist/ that the installed hooks, scribe and server run from; `npm run deploy`
// promotes a tested build. Usage: node scripts/build-to.mjs [root] [--node-only]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const root = resolve(repo, args.find((a) => !a.startsWith('--')) ?? '.build');
const nodeOnly = args.includes('--node-only');
if (resolve(root) === resolve(repo)) throw new Error('build-to: refusing to build over the live dist/ (pick another root)');

const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
const git = (cmdArgs) => {
  try {
    return execFileSync('git', cmdArgs, { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

run('npx', ['tsup', '--out-dir', `${root}/dist`]);
writeFileSync(
  `${root}/dist/build.json`,
  `${JSON.stringify({ sha: git(['rev-parse', '--short', 'HEAD']) || 'unknown', dirty: git(['status', '--porcelain']) !== '', builtAt: new Date().toISOString() }, null, 2)}\n`,
);
if (!nodeOnly) run('npx', ['vite', 'build', '--config', 'web/vite.config.ts', '--outDir', `${root}/web/dist`, '--emptyOutDir']);
// repoRoot() in the built CLI resolves to <root>, so install and doctor find their kit templates here.
rmSync(`${root}/claude`, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
cpSync(`${repo}/claude`, `${root}/claude`, { recursive: true });
console.log(`Built into ${root}${nodeOnly ? ' (server, MCP, CLI and hooks only)' : ''}`);
