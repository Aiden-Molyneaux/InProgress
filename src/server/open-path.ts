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
  if (process.platform === 'win32') return start(join(systemRoot(), 'explorer.exe'), [url], { windowsHide: true });
  return start(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { windowsHide: true });
}

/** Start a program detached, resolving once it started and rejecting when it could not. */
function start(file: string, args: string[], options: { windowsHide?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', ...options });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

/** The program a link scheme opens with, and its arguments with `%1` where the link goes. */
export interface LinkHandler {
  file: string;
  args: string[];
}

/**
 * The handler in `reg query <key>\shell\open\command /ve` output: the default value's command, split as Windows splits
 * it (a quoted or bare program, then arguments). Undefined when there is none, or when it cannot be run as it stands: a
 * program that is not an absolute path to an .exe, or one with `%VARS%` to expand. The value's label is localised
 * ("(Default)", "(Standard)"), so the line is found by its type.
 */
export function parseHandlerCommand(regOutput: string): LinkHandler | undefined {
  const command = /\sREG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(regOutput)?.[1];
  if (!command) return undefined;
  const [file, ...args] = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  if (!file || !isAbsolute(file) || !/\.exe$/i.test(file) || file.includes('%')) return undefined;
  return { file, args };
}

/**
 * The claude: handler on Windows, from the current user's classes and then the machine's (the Store install registers
 * the per-user one). reg.exe runs by absolute path from SystemRoot. Undefined elsewhere, or when there is no handler
 * whose program exists.
 */
function lookUpClaudeHandler(): LinkHandler | undefined {
  if (process.platform !== 'win32') return undefined;
  for (const hive of ['HKCU', 'HKLM']) {
    const reg = spawnSync(join(systemRoot(), 'System32', 'reg.exe'), ['query', `${hive}\\Software\\Classes\\claude\\shell\\open\\command`, '/ve'], { cwd: systemRoot(), encoding: 'utf8', windowsHide: true, timeout: LOOKUP_TIMEOUT_MS });
    const handler = reg.status === 0 ? parseHandlerCommand(reg.stdout) : undefined;
    if (handler && existsSync(handler.file)) return handler;
  }
  return undefined;
}

let claudeHandler: LinkHandler | undefined;

/** The claude: handler, kept while its program exists: an app update moves it, and then it is looked up again. A miss is not kept. */
export function findClaudeHandler(lookup: () => LinkHandler | undefined = lookUpClaudeHandler): LinkHandler | undefined {
  if (claudeHandler && !existsSync(claudeHandler.file)) claudeHandler = undefined;
  claudeHandler ??= lookup();
  return claudeHandler;
}

/** Forgets the kept handler: after one fails to start, and for tests. */
export const forgetClaudeHandler = (): void => {
  claudeHandler = undefined;
};

export interface OpenClaudeLinkOptions {
  findHandler?: () => LinkHandler | undefined;
  start?: (file: string, args: string[]) => Promise<void>;
  fallback?: (url: string) => Promise<void>;
}

/**
 * Open a claude:// link in the Claude desktop app. On Windows the app's own handler starts directly with the link, as
 * Windows would start it, which switches the session in about half the time explorer.exe takes (1.8 to 3.5 s against
 * 4.0 to 6.9 s, measured for #473). With no handler, or one that will not start, the link goes to openUrl. The caller
 * builds the link; no shell is involved.
 */
export async function openClaudeLink(url: string, o: OpenClaudeLinkOptions = {}): Promise<void> {
  const handler = (o.findHandler ?? findClaudeHandler)();
  const fallback = o.fallback ?? openUrl;
  if (!handler) return fallback(url);
  const args = handler.args.some((a) => a.includes('%1')) ? handler.args.map((a) => a.replaceAll('%1', () => url)) : [...handler.args, url];
  try {
    await (o.start ?? start)(handler.file, args);
  } catch {
    forgetClaudeHandler();
    await fallback(url);
  }
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
