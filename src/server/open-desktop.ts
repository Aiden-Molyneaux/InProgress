import { closeSync, existsSync, openSync, readdirSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { openClaudeLink } from './open-path';

/*
 * "Open session" hands the Claude desktop app its own link for the session, as the app does in its sidebar. It never
 * runs `claude --desktop --resume`: the CLI refuses --desktop without a terminal, and the server has none (#473).
 *
 * The link needs the app's own session id (local_<uuid>), not the CLI's. The app keeps one JSON file per Code-tab
 * session at <sessions dir>/<account>/<org>/local_<uuid>.json holding { sessionId, cliSessionId, isArchived,
 * lastActivityAt, ... }, which maps one to the other. Undocumented, so a file that does not read as that is skipped.
 */

/** What the open needs of a session: its CLI session id. */
export interface DesktopSession {
  id: string;
}

/** The session's folder when it is an absolute path to a folder that exists here; null otherwise. */
export function usableCwd(cwd: string | null): string | null {
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) return null;
  try {
    return statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    // Gone or unreadable between the two checks: not a folder to run in.
    return null;
  }
}

/**
 * Whether `cd "<cwd>"` in PowerShell goes exactly there. An allow-list, since PowerShell ends a double-quoted string at
 * curly quotes too and expands `$` and backticks: letters, digits, spaces and `_ . - \ / : ( ) + , @ ~` only. That
 * also keeps out `[ ]` (Set-Location reads them as wildcards) and `!` (bash history expansion). No trailing backslash
 * (it would escape the closing quote where a shell reads backslash escapes) and no leading `\\` (a UNC path).
 */
const quotable = (cwd: string): boolean => /^[\p{L}\p{N} _.\-\\/:()+,@~]+$/u.test(cwd) && !cwd.endsWith('\\') && !cwd.startsWith('\\\\');

/**
 * The command Aiden can run in a terminal when the desktop app could not open the session: a cd into the session's
 * folder first when it is known, else the bare command. The `cd "<folder>"; claude ...` form is for PowerShell (5.1 and
 * 7); bash runs it too for a plain path. A folder `quotable` refuses gets the bare command.
 */
export function resumeCommand(sessionId: string, cwd: string | null): string {
  const bare = `claude --resume ${sessionId}`;
  return cwd && quotable(cwd) ? `cd "${cwd}"; ${bare}` : bare;
}

/** The link the desktop app hands out for one of its sessions; opening it shows that session in the app. */
export const desktopLink = (appSessionId: string): string => `claude://claude.ai/epitaxy/${appSessionId}`;

/**
 * Where the desktop app keeps its session files. On Windows, Roaming; the Store (MSIX) install may keep them in its
 * package's LocalCache instead, so each Claude_* package is a candidate too. On macOS, Application Support. Elsewhere
 * there is no desktop app.
 */
export function desktopSessionDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')];
  if (platform !== 'win32') return [];
  const dirs = env.APPDATA ? [join(env.APPDATA, 'Claude', 'claude-code-sessions')] : [];
  if (env.LOCALAPPDATA) {
    const packages = join(env.LOCALAPPDATA, 'Packages');
    let names: string[] = [];
    try {
      names = readdirSync(packages).filter((n) => /^Claude_/i.test(n));
    } catch {
      // No Packages folder: no Store install.
    }
    for (const n of names) dirs.push(join(packages, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'));
  }
  return dirs;
}

/** An app session id as the app writes it; anything else never reaches a link. */
const APP_SESSION_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE = /^local_[0-9a-f-]+\.json$/i;

interface AppSession {
  appSessionId: string;
  cliSessionId: string;
  isArchived: boolean;
  lastActivityAt: number;
}

/** What each file read as, by path, kept while its mtime holds: a click reads only the files that changed. */
const fileCache = new Map<string, { mtimeMs: number; entry: AppSession | null }>();

async function readAppSession(file: string): Promise<AppSession | null> {
  try {
    const { mtimeMs } = await stat(file);
    const cached = fileCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.entry;
    const o = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const entry =
      typeof o.sessionId === 'string' && APP_SESSION_ID.test(o.sessionId) && typeof o.cliSessionId === 'string'
        ? { appSessionId: o.sessionId, cliSessionId: o.cliSessionId, isArchived: o.isArchived === true, lastActivityAt: Number(o.lastActivityAt ?? o.createdAt) || 0 }
        : null;
    fileCache.set(file, { mtimeMs, entry });
    return entry;
  } catch {
    // Gone, unreadable or half written: not a session to open.
    return null;
  }
}

/** The session files under a root, down to the <account>/<org> folders the app nests them in. */
async function sessionFiles(dir: string, depth = 2): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries.filter((e) => e.isFile() && SESSION_FILE.test(e.name)).map((e) => join(dir, e.name));
  if (depth === 0) return files;
  const nested = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => sessionFiles(join(dir, e.name), depth - 1)));
  return files.concat(...nested);
}

/** Every file under the roots that reads as an app session. */
async function appSessions(dirs: string[]): Promise<AppSession[]> {
  const files = (await Promise.all(dirs.map((d) => sessionFiles(d)))).flat();
  return (await Promise.all(files.map(readAppSession))).filter((e): e is AppSession => e !== null);
}

/**
 * The app session for a CLI session among those read, or undefined when there is none. Several can point at one CLI
 * session (a resumed one, say): one that is not archived wins, then the most recently active.
 */
const pick = (sessions: AppSession[], cliSessionId: string): string | undefined =>
  sessions
    .filter((e) => e.cliSessionId === cliSessionId)
    .sort((a, b) => Number(a.isArchived) - Number(b.isArchived) || b.lastActivityAt - a.lastActivityAt)[0]?.appSessionId;

/** The desktop app's session id for a CLI session, or undefined when the app has none. */
export async function findAppSession(cliSessionId: string, dirs: string[] = desktopSessionDirs()): Promise<string | undefined> {
  return pick(await appSessions(dirs), cliSessionId);
}

export interface OpenDesktopOptions {
  /** Where to look for the app's session files; replaceable so tests read a fixture. */
  dirs?: string[];
  /** Hands a link to the system; replaceable so tests never open the app. */
  openUrl?: (url: string) => Promise<void>;
}

/** What an open came to: done, or why not, in words for the window. */
export type OpenDesktopResult = { ok: true } | { ok: false; reason: string };

const NOT_IN_APP = "This session is not in the Claude desktop app, so it can't open there. Run this in a terminal to resume it.";
/** No file read as an app session at all: the app is missing, or it keeps its sessions somewhere or some way this does not know. */
const NO_APP_FILES = "InProgress could not find the Claude desktop app's session files, so it can't open the session there. Run this in a terminal to resume it.";

/**
 * Whether a lockfile is held open by its program: Chromium holds `<data dir>/lockfile` for as long as the app runs, and
 * opening it then fails with EBUSY. Any other failure (a read-only file, a denied folder) is not read as running, since
 * a wrong yes starts the handler as the app itself.
 */
function lockHeld(file: string): boolean {
  try {
    closeSync(openSync(file, 'r+'));
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EBUSY';
  }
}

/**
 * Whether the desktop app is running: its data folder (the parent of a sessions folder) has a lockfile the app holds.
 * About 10 ms, against a second for tasklist.exe. A lockfile that is missing or openable means it is not running.
 */
export function desktopAppRunning(dirs: string[] = desktopSessionDirs(), held: (file: string) => boolean = lockHeld): boolean {
  return dirs.some((d) => {
    const lock = join(dirname(d), 'lockfile');
    return existsSync(lock) && held(lock);
  });
}

/** Opens the session in the Claude desktop app through the app's own link, or says why it could not. */
export async function openInDesktop(session: DesktopSession, o: OpenDesktopOptions = {}): Promise<OpenDesktopResult> {
  const dirs = o.dirs ?? desktopSessionDirs();
  const sessions = await appSessions(dirs);
  if (sessions.length === 0) return { ok: false, reason: NO_APP_FILES };
  const appSessionId = pick(sessions, session.id);
  if (!appSessionId) return { ok: false, reason: NOT_IN_APP };
  try {
    await (o.openUrl ?? ((url: string) => openClaudeLink(url, { appRunning: () => desktopAppRunning(dirs) })))(desktopLink(appSessionId));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `The Claude desktop app could not be opened: ${err instanceof Error ? err.message : String(err)}` };
  }
}
