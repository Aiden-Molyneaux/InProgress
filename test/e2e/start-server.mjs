// Starts the tested build (.build, never the live dist/) with a fresh data dir so every e2e run begins empty.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const home = fileURLToPath(new URL('../../.e2e-home', import.meta.url));
rmSync(home, { recursive: true, force: true });
process.env.INPROGRESS_HOME = home;
process.env.INPROGRESS_PORT = process.env.INPROGRESS_E2E_PORT || '4399';
// The subagent transcript watcher ticks every minute; the e2e waits half a second.
process.env.INPROGRESS_AGENT_WATCH_MS = '500';
await import('../../.build/dist/server/main.js');
