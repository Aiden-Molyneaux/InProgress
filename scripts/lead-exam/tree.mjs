// Ends a process and everything it started. On Windows taskkill /T /F by pid (it takes the process itself too); elsewhere
// the children by parent pid, then the process.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function killTreeOf(pid, platform = process.platform) {
  if (platform === 'win32') {
    const root = process.env.SYSTEMROOT;
    spawnSync(root ? join(root, 'System32', 'taskkill.exe') : 'taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
    return;
  }
  spawnSync('pkill', ['-KILL', '-P', String(pid)]);
}
