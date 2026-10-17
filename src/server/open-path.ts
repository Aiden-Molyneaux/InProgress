import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Windows looks a bare program name up in the working directory before PATH, and where.exe searches
 * its working directory first. So system tools run by absolute path, and where.exe runs with
 * SystemRoot as its working directory.
 */
export const systemRoot = (): string => process.env.SystemRoot || 'C:\\Windows';

let vsCode: { path: string | undefined } | undefined;

/**
 * VS Code's real executable, looked up once per process. On Windows `code` is a .cmd shim, and
 * running it through cmd.exe would let characters like & | % in a stored path execute commands,
 * so we find Code.exe instead.
 */
export function findVsCode(): string | undefined {
  // VS Code may have been uninstalled or moved since the lookup: look again rather than fail silently.
  if (vsCode?.path && isAbsolute(vsCode.path) && !existsSync(vsCode.path)) vsCode = undefined;
  vsCode ??= { path: lookUpVsCode() };
  return vsCode.path;
}

/** The lookup blocks the event loop, so a hung lookup gives up after 3 s. */
const LOOKUP_TIMEOUT_MS = 3000;

function lookUpVsCode(): string | undefined {
  if (process.platform !== 'win32') {
    return spawnSync('which', ['code'], { stdio: 'ignore', timeout: LOOKUP_TIMEOUT_MS }).status === 0 ? 'code' : undefined;
  }
  const where = spawnSync(join(systemRoot(), 'System32', 'where.exe'), ['code'], { cwd: systemRoot(), encoding: 'utf8', windowsHide: true, timeout: LOOKUP_TIMEOUT_MS });
  const shims = where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const candidates = shims.map((shim) => join(dirname(dirname(shim)), 'Code.exe'));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
  return candidates.find((p) => existsSync(p));
}

/** Start a program detached. The error listener keeps a failed spawn (a missing program, say) from crashing the server. */
function launch(file: string, args: string[], onError?: () => void): void {
  spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => onError?.()).unref();
}

/**
 * Open an http(s) link in the default browser, whichever browser hosts the InProgress window. The caller has checked
 * the scheme; no shell is involved, so the URL is one argument however many `&` it holds.
 */
export async function openInDefaultBrowser(url: string): Promise<void> {
  // Fire and forget: a failed start is not reported to the window.
  openUrl(url).catch(() => {});
}

/**
 * Hand a link to the program registered for its scheme (claude:// is the Claude desktop app's). Resolves once the
 * opener started and rejects when it could not; whether the handler then opened the link is not reported back. The
 * caller builds the link; no shell is involved, so it is one argument.
 */
export function openUrl(url: string): Promise<void> {
  const [file, args] = process.platform === 'win32' ? [join(systemRoot(), 'explorer.exe'), [url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

/**
 * Open a file in VS Code, or reveal it in the file manager. No shell is involved and the file
 * never goes to the OS default handler, so nothing gets executed.
 */
export async function openInEditorOrReveal(path: string): Promise<void> {
  const target = resolve(path);
  const code = findVsCode();
  if (code) {
    // A Code.exe that will not start is forgotten, so the next open looks it up again.
    launch(code, [target], () => {
      if (vsCode?.path === code) vsCode = undefined;
    });
    return;
  }
  if (process.platform === 'win32') launch(join(systemRoot(), 'explorer.exe'), [`/select,${target}`]);
  else if (process.platform === 'darwin') launch('open', ['-R', target]);
  else launch('xdg-open', [dirname(target)]);
}
