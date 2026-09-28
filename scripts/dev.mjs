// Dev loop: builds into .dev-home/dist and restarts the server from there on port 4318, with .dev-home as its
// throwaway data dir, and runs Vite on 5183 for the UI (the dev server has no built UI, so it answers / with 503).
// The dev build never touches dist/: installed hooks, the scribe MCP server and ensure-server all run from it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, INPROGRESS_PORT: '4318', INPROGRESS_HOME: `${repo}.dev-home` };
const run = (command) => spawn(command, { cwd: repo, env, stdio: 'inherit', shell: true });
run('npx tsup --watch --out-dir .dev-home/dist --onSuccess "node .dev-home/dist/server/main.js"');
run('npx vite --config web/vite.config.ts');
