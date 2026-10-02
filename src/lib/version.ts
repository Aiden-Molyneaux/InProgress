import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BuildInfo } from '../core/build';

export { buildLabel, sameBuild, type BuildInfo } from '../core/build';

export const VERSION = '0.1.0';

/** Every bundle sits at dist/<dir>/<file>.js, so dist/build.json is one level up from any of them. */
export function buildFile(): string {
  return fileURLToPath(new URL('../build.json', import.meta.url));
}

export function readBuild(file: string = buildFile()): BuildInfo | null {
  try {
    const b = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildInfo>;
    return typeof b.sha === 'string' && typeof b.builtAt === 'string' ? { sha: b.sha, dirty: b.dirty === true, builtAt: b.builtAt } : null;
  } catch {
    return null;
  }
}
