// Starts the built server with a fresh data dir so every e2e run begins empty.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const home = fileURLToPath(new URL('../../.e2e-home', import.meta.url));
rmSync(home, { recursive: true, force: true });
process.env.INPROGRESS_HOME = home;
process.env.INPROGRESS_PORT = '4399';
await import('../../dist/server/main.js');
