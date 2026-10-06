import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_LINE, CARD_GAP, CARD_PAD, DONE_LINE, FOLD_ROW, INDENT, NODE_H, READERS_LINE, ROW, STACK_HEAD, TASK_ROW } from '../../src/core/layout';
import { PITCH } from '../../web/src/canvas/pitch';

/** The canvas region of styles.css, from its head comment to the next region's, without comments. */
function canvasRegion(): string {
  const css = readFileSync('web/src/styles.css', 'utf8');
  const start = css.indexOf('/* Region: canvas. Task 6. */');
  const end = css.indexOf('/* Region: Details and viewer. Task 5. */');
  if (start < 0 || end < start) throw new Error('styles.css has lost its canvas region heads');
  return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every rule that holds no nested block: its selectors, whitespace collapsed, and its declarations. */
function rules(css: string): { selectors: string[]; decls: [string, string][] }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
    decls: body.split(';').flatMap((d): [string, string][] => {
      const colon = d.indexOf(':');
      return colon < 0 ? [] : [[d.slice(0, colon).trim(), d.slice(colon + 1).trim()]];
    }),
  }));
}

/** The canvas rules that size a card's parts, and the property each one sizes them by. */
const PITCHED: [selector: string, property: string][] = [
  ['.ip-card > .ip-node', 'height'],
  ['.ip-node.stack', 'height'],
  ['.ip-badge', 'height'],
  ['.ip-readers', 'height'],
  ['.ip-lines > .ip-work-done', 'height'],
  ['.ip-card .ip-work', 'height'],
  ['.ip-trail-agent', 'height'],
  ['.ip-more', 'height'],
  ['.ip-card .ip-lines', 'padding-bottom'],
  ['.ip-card.stack .ip-lines', 'margin-top'],
];

const pitchVar = `var\\(--(?:${Object.keys(PITCH).map((k) => k.slice(2)).join('|')})\\)`;
/** A pitch variable, or a calc() that starts from one and adds or takes away others or the frame's two 1 px borders. */
const FROM_PITCH = new RegExp(`^(?:${pitchVar}|calc\\(${pitchVar}(?: [-+] (?:${pitchVar}|2px))*\\))$`);

describe('the canvas pitch', () => {
  it("is layout's: one custom property per exported constant", () => {
    expect(PITCH).toEqual({
      '--node-h': `${NODE_H}px`,
      '--card-gap': `${CARD_GAP}px`,
      '--row': `${ROW}px`,
      '--fold-row': `${FOLD_ROW}px`,
      '--agent-line': `${AGENT_LINE}px`,
      '--readers-line': `${READERS_LINE}px`,
      '--done-line': `${DONE_LINE}px`,
      '--task-row': `${TASK_ROW}px`,
      '--card-pad': `${CARD_PAD}px`,
      '--indent': `${INDENT}px`,
      '--stack-head': `${STACK_HEAD}px`,
    });
  });

  it('accepts a pitch variable and refuses a literal', () => {
    expect(['var(--agent-line)', 'calc(var(--node-h) - 2px)', 'calc(var(--stack-head) - var(--node-h))'].every((v) => FROM_PITCH.test(v))).toBe(true);
    expect(['28px', 'calc(28px + var(--node-h))', 'calc(var(--node-h) - 4px)', 'var(--fs-m)'].filter((v) => FROM_PITCH.test(v))).toEqual([]);
  });

  it.each(PITCHED)('sizes %s by its %s from the pitch', (selector, property) => {
    const values = rules(canvasRegion())
      .filter((r) => r.selectors.includes(selector))
      .flatMap((r) => r.decls.filter(([p]) => p === property).map(([, v]) => v));
    expect(values, `${selector} { ${property} }`).not.toEqual([]);
    for (const v of values) expect(v, `${selector} { ${property}: ${v} }`).toMatch(FROM_PITCH);
  });

  it('sets no literal height in those rules', () => {
    const pitched = new Set(PITCHED.map(([s]) => s));
    const literal = rules(canvasRegion())
      .filter((r) => r.selectors.some((s) => pitched.has(s)))
      .flatMap((r) => r.decls.filter(([p, v]) => /^(?:min-|max-)?height$/.test(p) && !FROM_PITCH.test(v)).map(([p, v]) => `${r.selectors.join(', ')} { ${p}: ${v} }`));
    expect(literal).toEqual([]);
  });
});
