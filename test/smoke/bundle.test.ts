import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The tested build: `npm run test:smoke` builds into .build, so the live dist/ is never touched. */
const BUILD = process.env.INPROGRESS_BUILD_ROOT ?? '.build';
const ENTRIES = ['server/main.js', 'mcp/main.js', 'cli/main.js', 'hooks/hook.js'];
/** better-sqlite3 loads a native binding from its own folder, so it must stay outside the bundles. */
const EXTERNAL = new Set(['better-sqlite3']);
const builtins = new Set(builtinModules);

/**
 * Every module a bundle asks Node for at run time: static and dynamic imports, and require() calls. In ESM output
 * esbuild routes each real require() through its __require shim; a bare `require(` in the bundle is code that ajv and
 * fast-json-stringify generate as strings for their standalone mode, never a load.
 */
function specifiers(code: string): string[] {
  const patterns = [/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm, /^\s*import\s*["']([^"']+)["']/gm, /\bimport\(\s*["']([^"']+)["']\s*\)/g, /\b__require\d*\(\s*["']([^"']+)["']\s*\)/g];
  return [...new Set(patterns.flatMap((p) => [...code.matchAll(p)].map((m) => m[1])))];
}

/** A package name from a specifier: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. */
const packageOf = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

describe('bundled build (#60)', () => {
  it.each(ENTRIES)('%s loads only Node built-ins and better-sqlite3', (entry) => {
    const code = readFileSync(join(BUILD, 'dist', entry), 'utf8');
    const outside = specifiers(code).filter((s) => !s.startsWith('node:') && !builtins.has(s) && !EXTERNAL.has(packageOf(s)) && !s.startsWith('.'));
    expect(outside).toEqual([]);
  });

  it('keeps better-sqlite3 outside the server bundle', () => {
    const code = readFileSync(join(BUILD, 'dist', 'server/main.js'), 'utf8');
    expect(specifiers(code).map(packageOf)).toContain('better-sqlite3');
  });
});
