import { describe, expect, it } from 'vitest';
import { parseWithStepRefs } from '../../web/src/panels/stepMarked';

const has = (id: number) => id === 39 || id === 289 || id === 5;

describe('parseWithStepRefs', () => {
  it('links a known #id at a word start', () => {
    expect(parseWithStepRefs('see #5 now', has)).toContain('<a href="#step-5" data-step="5">#5</a>');
  });

  it('leaves an unknown #id as text', () => {
    expect(parseWithStepRefs('see #6 now', has)).not.toContain('data-step');
  });

  it('keeps a link whose text is a #id as one link', () => {
    const html = parseWithStepRefs('[#289](https://example.com/x)', has);
    expect(html).toBe('<p><a href="https://example.com/x">#289</a></p>\n');
  });

  it('keeps a numeric entity as text', () => {
    const html = parseWithStepRefs('it&#39;s fine', has);
    expect(html).not.toContain('data-step');
    expect(html).toContain('&#39;');
  });
});
