import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * VS Code's real executable. On Windows `code` is a .cmd shim, and running it through cmd.exe
 * would let characters like & | % in a stored path execute commands, so we find Code.exe instead.
 */
export function findVsCode(): string | undefined {
  if (process.platform !== 'win32') {
    return spawnSync('which', ['code'], { stdio: 'ignore' }).status === 0 ? 'code' : undefined;
  }
  const where = spawnSync('where', ['code'], { encoding: 'utf8', windowsHide: true });
  const shims = where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const candidates = shims.map((shim) => join(dirname(dirname(shim)), 'Code.exe'));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
  return candidates.find((p) => existsSync(p));
}

/**
 * Open a file in VS Code, or reveal it in the file manager. No shell is involved and the file
 * never goes to the OS default handler, so nothing gets executed.
 */
export async function openInEditorOrReveal(path: string): Promise<void> {
  const target = resolve(path);
  const detached = { detached: true, stdio: 'ignore' as const, windowsHide: true };
  const code = findVsCode();
  if (code) {
    spawn(code, [target], detached).unref();
    return;
  }
  if (process.platform === 'win32') spawn('explorer.exe', [`/select,${target}`], detached).unref();
  else if (process.platform === 'darwin') spawn('open', ['-R', target], detached).unref();
  else spawn('xdg-open', [dirname(target)], detached).unref();
}
