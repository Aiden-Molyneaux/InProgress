// The desktop shell's decisions, kept free of electron so they can be unit-tested: which node runs the server, which
// links stay in the window, where the window was last, and what the Start Menu shortcut says.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemRoot } from '../server/open-path';

/** The AppUserModelID shared by the window and the shortcut, so the pin and the window are one taskbar button. */
export const DESKTOP_APP_ID = 'InProgress.Desktop';

/** `--node=<path>` from the command line: the node.exe that starts the server (Electron's own cannot load better-sqlite3). */
export function parseDesktopArgs(argv: string[]): { node?: string } {
  const arg = argv.find((a) => a.startsWith('--node='));
  const node = arg?.slice('--node='.length);
  return node ? { node } : {};
}

/** The first node on PATH. Like the VS Code lookup: where.exe by absolute path from SystemRoot, 3 s at most. */
export function lookUpNode(platform: string = process.platform): string | undefined {
  if (platform === 'win32') {
    const where = spawnSync(join(systemRoot(), 'System32', 'where.exe'), ['node'], { cwd: systemRoot(), encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const found = where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
    return found.find((p) => existsSync(p));
  }
  const which = spawnSync('which', ['node'], { encoding: 'utf8', timeout: 3000 });
  return which.status === 0 ? which.stdout.trim() || undefined : undefined;
}

/** The node to run the server with: the `--node` path when it exists, else whatever the lookup finds. */
export function nodeForServer(o: { argNode?: string; platform: string; lookup?: () => string | undefined; exists?: (path: string) => boolean }): string | undefined {
  if (o.argNode && (o.exists ?? existsSync)(o.argNode)) return o.argNode;
  return (o.lookup ?? (() => lookUpNode(o.platform)))();
}

/** Whether a URL belongs to the app: the same origin as the server's base URL. */
export function isAppUrl(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** The URL when it is safe to hand to the default browser (http or https), else undefined. */
export function externalTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 400;

/** The saved window bounds, or undefined when the file is missing, unreadable or holds anything but sane integers. */
export function readBounds(file: string): Bounds | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined; // No file yet, or one that is not JSON: the window opens at its default place.
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const { x, y, width, height } = raw as Record<string, unknown>;
  if (![x, y, width, height].every((n) => Number.isInteger(n))) return undefined;
  if ((width as number) < MIN_WIDTH || (height as number) < MIN_HEIGHT) return undefined;
  return { x, y, width, height } as Bounds;
}

export function writeBounds(file: string, b: Bounds): void {
  writeFileSync(file, `${JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height })}\n`);
}

/** The bounds when their top-left 40 by 40 lies inside a display's work area, else undefined (a monitor that was unplugged). */
export function visibleBounds(b: Bounds, displays: Bounds[]): Bounds | undefined {
  const inside = displays.some((d) => b.x >= d.x && b.y >= d.y && b.x + 40 <= d.x + d.width && b.y + 40 <= d.y + d.height);
  return inside ? b : undefined;
}

/** The Start Menu shortcut's path: Windows only, and only where APPDATA says where the Start Menu is. */
export function shortcutPath(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | undefined {
  if (platform !== 'win32' || !env.APPDATA) return undefined;
  return join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'InProgress.lnk');
}

/** Double quotes around one path, so a space in it stays inside its argument. */
const quote = (path: string): string => `"${path}"`;

/** What the shortcut and the taskbar's relaunch command run: Electron on this main.js, with the node for the server. */
export function launchDetails(o: { electron: string; main: string; node?: string; icon: string; home: string }) {
  const args = `${quote(o.main)}${o.node ? ` --node=${quote(o.node)}` : ''}`;
  return { target: o.electron, args, appUserModelId: DESKTOP_APP_ID, icon: o.icon, iconIndex: 0, cwd: o.home, description: 'InProgress' };
}
