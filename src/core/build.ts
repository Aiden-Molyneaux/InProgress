/** Which build is running: written to dist/build.json by scripts/build-to.mjs, absent in dev and test runs. */
export interface BuildInfo {
  sha: string;
  dirty: boolean;
  builtAt: string;
}

/** True unless both sides are known and differ: without build info (dev, tests) there is nothing to compare. */
export function sameBuild(a: BuildInfo | null | undefined, b: BuildInfo | null | undefined): boolean {
  return !a || !b || (a.sha === b.sha && a.builtAt === b.builtAt);
}

export const buildLabel = (b: BuildInfo | null | undefined): string => (b ? `${b.sha}${b.dirty ? '+dirty' : ''} (${b.builtAt})` : 'unknown build');
