import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DESKTOP_APP_ID, externalTarget, isAppUrl, launchDetails, nodeForServer, parseDesktopArgs, readBounds, shortcutPath, visibleBounds, writeBounds } from '../../src/desktop/logic';

const dir = mkdtempSync(join(tmpdir(), 'ip-desktop-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('desktop arguments', () => {
  it('reads --node=<path>, with spaces kept', () => {
    expect(parseDesktopArgs(['C:\\app\\main.js', '--node=C:\\Program Files\\nodejs\\node.exe'])).toEqual({ node: 'C:\\Program Files\\nodejs\\node.exe' });
    expect(parseDesktopArgs(['main.js'])).toEqual({});
    expect(parseDesktopArgs(['--node='])).toEqual({});
  });
});

describe('nodeForServer', () => {
  const here = join(dir, 'node-stand-in.exe');
  writeFileSync(here, '');
  it('prefers --node when it exists', () => {
    expect(nodeForServer({ argNode: here, platform: 'win32', lookup: () => 'looked-up' })).toBe(here);
  });
  it('looks node up when --node is missing or does not exist', () => {
    expect(nodeForServer({ platform: 'win32', lookup: () => 'looked-up' })).toBe('looked-up');
    expect(nodeForServer({ argNode: join(dir, 'gone.exe'), platform: 'win32', lookup: () => 'looked-up' })).toBe('looked-up');
  });
  it('is undefined when nothing is found', () => {
    expect(nodeForServer({ platform: 'win32', lookup: () => undefined })).toBeUndefined();
  });
});

describe('link routing', () => {
  it('keeps only the server origin in the window, port included', () => {
    expect(isAppUrl('http://127.0.0.1:4317/#/p/1', 'http://127.0.0.1:4317')).toBe(true);
    expect(isAppUrl('http://127.0.0.1:4318/', 'http://127.0.0.1:4317')).toBe(false);
    expect(isAppUrl('http://localhost:4317/', 'http://127.0.0.1:4317')).toBe(false);
    expect(isAppUrl('not a url', 'http://127.0.0.1:4317')).toBe(false);
  });
  it('hands only http and https links to the browser', () => {
    expect(externalTarget('https://example.com/a?b=1&c=2')).toBe('https://example.com/a?b=1&c=2');
    expect(externalTarget('http://example.com')).toBe('http://example.com/');
    for (const bad of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'claude://x', 'data:text/html,x', 'nonsense']) expect(externalTarget(bad), bad).toBeUndefined();
  });
});

describe('window bounds', () => {
  const file = join(dir, 'desktop.json');
  const good = { x: 10, y: 20, width: 520, height: 1000 };
  it('round-trips through the file', () => {
    writeBounds(file, good);
    expect(readBounds(file)).toEqual(good);
  });
  it('rejects a missing file and malformed content', () => {
    expect(readBounds(join(dir, 'absent.json'))).toBeUndefined();
    const read = (content: string) => {
      writeFileSync(file, content);
      return readBounds(file);
    };
    expect(read('not json')).toBeUndefined();
    expect(read('null')).toBeUndefined();
    expect(read(JSON.stringify({ ...good, x: 1.5 }))).toBeUndefined();
    expect(read(JSON.stringify({ ...good, y: '20' }))).toBeUndefined();
    expect(read(JSON.stringify({ x: 1, y: 2, width: 520 }))).toBeUndefined();
    expect(read(JSON.stringify({ ...good, width: 319 }))).toBeUndefined();
    expect(read(JSON.stringify({ ...good, height: 399 }))).toBeUndefined();
    expect(read(JSON.stringify({ ...good, width: 320, height: 400 }))).toEqual({ ...good, width: 320, height: 400 });
  });
  it('drops bounds whose top-left corner is off every display', () => {
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1040 },
      { x: 1920, y: 0, width: 1280, height: 1024 },
    ];
    expect(visibleBounds(good, displays)).toEqual(good);
    expect(visibleBounds({ ...good, x: 2000 }, displays)).toBeDefined();
    expect(visibleBounds({ ...good, x: 3300 }, displays)).toBeUndefined();
    expect(visibleBounds({ ...good, x: -1200 }, displays)).toBeUndefined();
    expect(visibleBounds({ ...good, x: 1900 }, [displays[0]])).toBeUndefined(); // the 40 px corner would hang off the edge
    expect(visibleBounds(good, [])).toBeUndefined();
  });
});

describe('Start Menu shortcut', () => {
  it('lives under APPDATA on Windows only', () => {
    expect(shortcutPath({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'InProgress.lnk'));
    expect(shortcutPath({}, 'win32')).toBeUndefined();
    expect(shortcutPath({ APPDATA: '/x' }, 'linux')).toBeUndefined();
  });
  it('quotes each path and shares the AppUserModelID', () => {
    const base = { electron: 'C:\\r\\electron.exe', main: 'C:\\my repo\\dist\\desktop\\main.js', icon: 'C:\\my repo\\dist\\desktop\\inprogress.ico', home: 'C:\\Users\\a\\.inprogress' };
    expect(launchDetails({ ...base, node: 'C:\\Program Files\\nodejs\\node.exe' })).toEqual({
      target: 'C:\\r\\electron.exe',
      args: '"C:\\my repo\\dist\\desktop\\main.js" --node="C:\\Program Files\\nodejs\\node.exe"',
      appUserModelId: DESKTOP_APP_ID,
      icon: base.icon,
      iconIndex: 0,
      cwd: base.home,
      description: 'InProgress',
    });
    expect(launchDetails(base).args).toBe('"C:\\my repo\\dist\\desktop\\main.js"');
  });
});
