import { describe, expect, it } from 'vitest';
import { publishesFolderPackage } from '../../src/server/lead/hold';
import { publishDestination } from '../../src/server/lead/landing';

describe('publishesFolderPackage', () => {
  it("is true for a publish of the folder's own package, with only flags known to leave it as it is", () => {
    for (const c of ['npm publish', 'pnpm publish --access public', 'yarn publish --tag next', 'npm publish --otp 123456 --dry-run', 'npm publish --tag=beta --provenance']) {
      expect(publishesFolderPackage(c), c).toBe(true);
    }
  });

  it('is false for a path or tarball, a workspace or prefix publish, a version bump, an unknown flag, a setting in front, or no publish', () => {
    for (const c of [
      'npm publish ./pkg',
      'npm publish x-1.2.0.tgz',
      'npm publish --tag next ./pkg',
      'npm publish -w api',
      'npm publish -ws',
      'npm publish --workspaces',
      'pnpm publish --filter web',
      'pnpm publish -r',
      'npm publish --prefix=../other',
      'npm publish --prefix ../other',
      'yarn publish --minor',
      'yarn publish --new-version=2.0.0',
      'yarn publish --new-version 2.0.0',
      'npm publish --something-new',
      'NPM_CONFIG_REGISTRY=https://x.invalid npm publish',
      'npm_config_dry_run=true npm publish',
      'npm run build',
    ]) {
      expect(publishesFolderPackage(c), c).toBe(false);
    }
  });
});

describe('publishDestination', () => {
  it('names --ignore-scripts and --dry-run, so a yes for either never clears a plain publish', () => {
    expect(publishDestination('npm publish --ignore-scripts')).toEqual(['--ignore-scripts']);
    expect(publishDestination('npm publish --dry-run --ignore-scripts')).toEqual(['--dry-run', '--ignore-scripts']);
    expect(publishDestination('npm publish')).toEqual([]);
  });
});
