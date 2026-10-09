import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../..', import.meta.url));

type Handler = { type?: string; command?: string; args?: string[]; timeout?: number };
type Settings = { autoCompactWindow?: number; hooks?: Record<string, { matcher?: string; hooks?: Handler[] }[]> };
const settings: Settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));

describe('.claude/settings.json', () => {
  it('compacts at 300000 tokens', () => {
    expect(settings.autoCompactWindow).toBe(300000);
  });
  it('registers the context nudge on PostToolBatch, and its script exists', () => {
    const handlers = (settings.hooks?.PostToolBatch ?? []).flatMap((group) => group.hooks ?? []);
    expect(handlers).toHaveLength(1);
    const [hook] = handlers;
    expect(hook.command).toBe('node');
    const arg = hook.args?.[0] ?? '';
    // Claude Code fills the placeholder in at run time; a path without it would only work from one folder.
    expect(arg.startsWith('${CLAUDE_PROJECT_DIR}/')).toBe(true);
    const script = resolve(arg.replace('${CLAUDE_PROJECT_DIR}', () => repo));
    expect(existsSync(script) && statSync(script).isFile(), `${script} should be a file`).toBe(true);
  });
});
