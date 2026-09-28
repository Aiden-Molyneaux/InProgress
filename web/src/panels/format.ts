import type { ResourceMeta } from '../../../src/core/types';

export function resourceSummary(r: ResourceMeta): string {
  const parts: string[] = [r.kind];
  if (r.contentLength) parts.push(r.contentLength >= 1000 ? `${(r.contentLength / 1000).toFixed(1)}k chars` : `${r.contentLength} chars`);
  if (r.path) parts.push('file');
  if (r.url) parts.push('link');
  return parts.join(' · ');
}
