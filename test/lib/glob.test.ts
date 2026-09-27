import { describe, expect, it } from 'vitest';
import { globMatch } from '../../src/lib/glob';

describe('globMatch', () => {
  it('matches * anywhere, case-insensitively', () => {
    expect(globMatch('*VCAD-978*', 'feature/VCAD-978-fix')).toBe(true);
    expect(globMatch('*vcad-978*', 'feature/VCAD-978')).toBe(true);
    expect(globMatch('release/*', 'release/1.2')).toBe(true);
  });
  it('anchors the whole value', () => {
    expect(globMatch('main', 'main2')).toBe(false);
  });
  it('treats regex characters literally and ? as one character', () => {
    expect(globMatch('v1.2', 'v1x2')).toBe(false);
    expect(globMatch('v?.2', 'v1.2')).toBe(true);
  });
});
