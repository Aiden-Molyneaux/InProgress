import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Windows looks a bare program name up in the working directory before PATH, and where.exe searches
 * its working directory first. So system tools run by absolute path, and where.exe runs with
 * SystemRoot as its working directory.
 */
const systemRoot = () => process.env.SystemRoot || 'C:\\Windows';

let vsCode: { path: string | undefined } | undefined;

/**
 * VS Code's real executable, looked up once per process. On Windows `code` is a .cmd shim, and
 * running it through cmd.exe would let characters like & | % in a stored path execute commands,
 * so we find Code.exe instead.
 */
export function findVsCode(): string | undefined {
  vsCode ??= { path: lookUpVsCode() };
  return vsCode.path;
}

function lookUpVsCode(): string | undefined {
  if (process.platform !== 'win32') {
    return spawnSync('which', ['code'], { stdio: 'ignore' }).status === 0 ? 'code' : undefined;
  }
  const where = spawnSync(join(systemRoot(), 'System32', 'where.exe'), ['code'], { cwd: systemRoot(), encoding: 'utf8', windowsHide: true });
  const shims = where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const candidates = shims.map((shim) => join(dirname(dirname(shim)), 'Code.exe'));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
  return candidates.find((p) => existsSync(p));
}

/** Start a program detached. The error listener keeps a failed spawn (a missing program, say) from crashing the server. */
function launch(file: string, args: string[]): void {
  spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => undefined).unref();
}

/**
 * Open a file in VS Code, or reveal it in the file manager. No shell is involved and the file
 * never goes to the OS default handler, so nothing gets executed.
 */
export async function openInEditorOrReveal(path: string): Promise<void> {
  const target = resolve(path);
  const code = findVsCode();
  if (code) {
    launch(code, [target]);
    return;
  }
  if (process.platform === 'win32') launch(join(systemRoot(), 'explorer.exe'), [`/select,${target}`]);
  else if (process.platform === 'darwin') launch('open', ['-R', target]);
  else launch('xdg-open', [dirname(target)]);
}
