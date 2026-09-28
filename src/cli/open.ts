import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function findEdge(): string | undefined {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter((b): b is string => !!b);
  return bases.map((b) => join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((p) => existsSync(p));
}

export function edgeArgs(url: string): string[] {
  return [`--app=${url}`, '--window-size=520,1000'];
}

/** Open the UI as a chromeless Edge window, else in the default browser. */
export function openAppWindow(url: string): void {
  const edge = findEdge();
  const detached = { detached: true, stdio: 'ignore' as const };
  if (edge) spawn(edge, edgeArgs(url), detached).unref();
  else if (process.platform === 'win32') spawn('explorer.exe', [url], detached).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], detached).unref();
}
