import { describe, expect, it } from 'vitest';
import { publishesFolderPackage } from '../../src/server/lead/hold';

describe('publishesFolderPackage', () => {
  it("is true for a publish of the folder's own package, with flags and their values", () => {
    for (const c of ['npm publish', 'pnpm publish --access public', 'yarn publish --tag next', 'npm publish --otp 123456 --dry-run', 'npm publish --tag=beta']) {
      expect(publishesFolderPackage(c), c).toBe(true);
    }
  });

  it('is false for a path or tarball, a workspace publish, or no publish at all', () => {
    for (const c of ['npm publish ./pkg', 'npm publish x-1.2.0.tgz', 'npm publish --tag next ./pkg', 'npm publish -w api', 'pnpm publish --filter web', 'pnpm publish -r', 'npm run build']) {
      expect(publishesFolderPackage(c), c).toBe(false);
    }
  });
});
