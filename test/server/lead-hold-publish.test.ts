import { describe, expect, it } from 'vitest';
import { publishesFolderPackage } from '../../src/server/lead/hold';

describe('publishesFolderPackage', () => {
  it("is true for a publish of the folder's own package, with only flags known to leave it as it is", () => {
    for (const c of ['npm publish', 'pnpm publish --access public', 'yarn publish --tag next', 'npm publish --otp 123456 --dry-run', 'npm publish --tag=beta --provenance']) {
      expect(publishesFolderPackage(c), c).toBe(true);
    }
  });

  it('is false for a path or tarball, a workspace or prefix publish, a version bump, an unknown flag, or no publish', () => {
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
      'npm run build',
    ]) {
      expect(publishesFolderPackage(c), c).toBe(false);
    }
  });
});
