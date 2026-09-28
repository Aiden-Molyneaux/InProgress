import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTranscriptTitle } from '../../src/lib/transcript';

const line = (o: object) => JSON.stringify(o);

describe('readTranscriptTitle', () => {
  it('returns the last custom-title entry', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ip-tr-')), 't.jsonl');
    writeFileSync(file, [
      line({ type: 'user', message: 'hi' }),
      line({ type: 'custom-title', customTitle: 'Old name', sessionId: 's' }),
      line({ type: 'assistant', message: 'ok' }),
      line({ type: 'custom-title', customTitle: 'InGame launch status', sessionId: 's' }),
      '',
    ].join('\n'));
    expect(readTranscriptTitle(file)).toBe('InGame launch status');
  });
  it('returns undefined when there is no title or no file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ip-tr-')), 't.jsonl');
    writeFileSync(file, `${line({ type: 'user' })}\n`);
    expect(readTranscriptTitle(file)).toBeUndefined();
    expect(readTranscriptTitle(join(tmpdir(), 'does-not-exist.jsonl'))).toBeUndefined();
  });
  it('only reads the tail window', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ip-tr-')), 't.jsonl');
    writeFileSync(file, `${line({ type: 'custom-title', customTitle: 'Early' })}\n${'x'.repeat(5000)}\n`);
    expect(readTranscriptTitle(file, 1000)).toBeUndefined();
  });
});
