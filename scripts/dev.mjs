// Dev loop: rebuilds and restarts the server on port 4318 with a throwaway data dir, and runs Vite on 5183.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, INPROGRESS_PORT: '4318', INPROGRESS_HOME: `${repo}.dev-home` };
const run = (command) => spawn(command, { cwd: repo, env, stdio: 'inherit', shell: true });
run('npx tsup --watch --onSuccess "node dist/server/main.js"');
run('npx vite --config web/vite.config.ts');
