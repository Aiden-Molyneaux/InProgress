import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOW_RULES, HOOK_DEFS, install, uninstall } from '../../src/cli/claude-config';

const repo = process.cwd().replace(/\\/g, '/');

function claudeDirWithSettings(settings: object | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'ip-claude-'));
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}
const readSettings = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

const existing = {
  model: 'opus',
  enabledPlugins: { 'superpowers@claude-plugins-official': true },
  permissions: { allow: ['Bash(git status)'] },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool --stop' }] }] },
};

describe('install', () => {
  it('merges exec-form hooks and allow rules while preserving everything else', () => {
    const dir = claudeDirWithSettings(existing);
    const { log, agentsDirCreated } = install({ repo, claudeDir: dir, stamp: '20260927-120000' });
    expect(agentsDirCreated).toBe(true);
    expect(log.join('\n')).toContain('restart');
    const s = readSettings(dir);
    expect(s.model).toBe('opus');
    expect(s.enabledPlugins).toEqual(existing.enabledPlugins);
    expect(s.permissions.allow).toEqual(['Bash(git status)', ...ALLOW_RULES]);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('other-tool --stop');
    for (const def of HOOK_DEFS) {
      const group = s.hooks[def.event].at(-1);
      expect(group.matcher).toBe(def.matcher);
      expect(group.hooks[0]).toEqual({ type: 'command', command: process.execPath.replace(/\\/g, '/'), args: [`${repo}/dist/hooks/hook.js`, def.name], timeout: def.timeout });
    }
    expect(existsSync(join(dir, 'settings.json.inprogress-backup-20260927-120000'))).toBe(true);
    const agent = readFileSync(join(dir, 'agents', 'inprogress-scribe.md'), 'utf8');
    expect(agent).toContain(`args: ["${repo}/dist/mcp/main.js"]`);
    expect(agent).not.toContain('{{REPO}}');
    expect(agent).toContain(`command: "${process.execPath.replace(/\\/g, '/')}"`);
    expect(readFileSync(join(dir, 'skills', 'inprogress', 'SKILL.md'), 'utf8')).toContain(`${repo}/dist/cli/main.js`);
  });

  it('is idempotent and reports an existing agents dir', () => {
    const dir = claudeDirWithSettings(existing);
    mkdirSync(join(dir, 'agents'));
    install({ repo, claudeDir: dir, stamp: 'a' });
    const second = install({ repo, claudeDir: dir, stamp: 'b' });
    expect(second.agentsDirCreated).toBe(false);
    const s = readSettings(dir);
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.permissions.allow.filter((r: string) => r === 'mcp__inprogress')).toHaveLength(1);
  });

  it('works without an existing settings file', () => {
    const dir = claudeDirWithSettings(undefined);
    install({ repo, claudeDir: dir, stamp: 'c' });
    expect(Object.keys(readSettings(dir).hooks)).toHaveLength(HOOK_DEFS.length);
  });
});

describe('uninstall', () => {
  it('removes exactly what install added', () => {
    const dir = claudeDirWithSettings(existing);
    install({ repo, claudeDir: dir, stamp: 'd' });
    uninstall({ claudeDir: dir, stamp: 'e' });
    const s = readSettings(dir);
    expect(s).toEqual(existing);
    expect(existsSync(join(dir, 'agents', 'inprogress-scribe.md'))).toBe(false);
    expect(existsSync(join(dir, 'skills', 'inprogress'))).toBe(false);
  });
});
