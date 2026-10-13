import { describe, expect, it } from 'vitest';
import type { ResourceMeta } from '../../src/core/types';
import { resourceSummary } from '../../web/src/panels/format';

const base: ResourceMeta = { id: 1, projectId: 1, nodeId: 1, kind: 'test-suite', title: 'Suite', path: null, url: null, contentLength: 0, sessionId: null, createdAt: 't', updatedAt: 't', purpose: null };

describe('resourceSummary', () => {
  it('summarizes kind, size, and where it lives', () => {
    expect(resourceSummary({ ...base, contentLength: 420 })).toBe('test-suite · 420 chars');
    expect(resourceSummary({ ...base, contentLength: 3210, path: 'C:/x.md' })).toBe('test-suite · 3.2k chars · file');
    expect(resourceSummary({ ...base, kind: 'link', url: 'https://example.com' })).toBe('link · link');
  });

  it('switches to k at 1000 chars and lists both file and link', () => {
    expect(resourceSummary({ ...base, path: 'C:/x.md', url: 'https://example.com' })).toBe('test-suite · file · link');
    expect(resourceSummary({ ...base, contentLength: 999 })).toBe('test-suite · 999 chars');
    expect(resourceSummary({ ...base, contentLength: 1000 })).toBe('test-suite · 1.0k chars');
  });
});
