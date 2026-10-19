import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** A sheet with its comments taken out, so a comment can never pass for a rule. */
const uncommented = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The tokens' sheet. */
const css = uncommented('web/src/styles/tokens.css');
/** Every sheet in web/src/styles/ but the tokens', with its @font-face blocks taken out: their descriptors are not rules. */
const SHEET_NAMES = readdirSync('web/src/styles').filter((name) => name.endsWith('.css'));
const rules = SHEET_NAMES.filter((name) => name !== 'tokens.css')
  .map((name) => uncommented(`web/src/styles/${name}`).replace(/@font-face\s*\{[^}]*\}/g, ''))
  .join('\n');
/** Every sheet, the tokens' included. */
const sheets = `${css}\n${rules}`;

/** Every file under web/src, for the checks that hold across the whole window. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The custom properties a block declares: name (without the --) to value. */
function tokens(body: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (body ?? '').matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** The one :root block outside any media query holds the palette. */
const root = tokens(/^:root\s*\{([^}]*)\}/m.exec(css)?.[1]);
/** The display sizes and the section space step down under 720 px. */
const narrow = tokens(/@media \(max-width: 719px\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1]);

/** v3's colours (spec 2.3). */
const COLOUR: Record<string, string> = {
  'canvas-0': '#000000',
  'canvas-1': '#111111',
  'canvas-2': '#161616',
  'canvas-3': '#1e1e1e',
  'canvas-4': '#282828',
  text: '#f2f2f2',
  'text-hi': '#ffffff',
  'text-muted': '#8f8f8f',
  'text-dim': '#6f6f6f',
  volt: '#c0fe04',
  'volt-ink': '#000000',
  'volt-soft': 'rgba(192, 254, 4, 0.22)',
  'volt-wash': 'rgba(192, 254, 4, 0.06)',
  alarm: '#f24723',
  'alarm-soft': 'rgba(242, 71, 35, 0.22)',
  'alarm-wash': 'rgba(242, 71, 35, 0.08)',
  violet: '#5200ff',
  'violet-ink': '#9f7bff',
  'line-soft': 'rgba(255, 255, 255, 0.06)',
  line: 'rgba(255, 255, 255, 0.09)',
  'line-strong': 'rgba(255, 255, 255, 0.13)',
  'line-bright': 'rgba(255, 255, 255, 0.2)',
  scrim: 'rgba(0, 0, 0, 0.65)',
};

/** The seven factions behind the stored hue index, in index order (spec 2.4, D3). */
const HUES: [string, string][] = [
  ['hue-0', '#3ad6ff'],
  ['hue-1', '#ff4d9d'],
  ['hue-2', '#b66dff'],
  ['hue-3', '#59b41d'],
  ['hue-4', '#9ebf9c'],
  ['hue-5', '#ff6b00'],
  ['hue-6', '#f6e935'],
];

/** Faces, the type ramp, weights, space, motion and layers (spec 2.2, 2.5 to 2.8), with their under-720 px values. */
const SCALE: Record<string, string> = {
  'font-display': "'Archivo', 'Arial Black', sans-serif",
  'font-body': "'Archivo', system-ui, 'Segoe UI', 'Segoe UI Symbol', sans-serif",
  'font-brand': "'Martian Mono', ui-monospace, 'Cascadia Mono', Consolas, 'Segoe UI Symbol', monospace",
  'font-mono': "'Martian Mono', ui-monospace, 'Cascadia Mono', Consolas, 'Segoe UI Symbol', monospace",
  'font-dot': "'Doto', 'Martian Mono', monospace",
  't-h1': '2rem',
  't-h2': '1.5rem',
  't-h3': '1.125rem',
  't-title': '1rem',
  't-body': '0.9375rem',
  't-detail-sm': '0.75rem',
  't-micro': '0.625rem',
  'w-body': '400',
  'w-strong': '600',
  'w-brand': '700',
  'w-display': '800',
  'sp-1': '4px',
  'sp-2': '8px',
  'sp-3': '12px',
  'sp-4': '16px',
  'sp-5': '20px',
  'sp-6': '24px',
  'sp-8': '32px',
  'sp-section': '32px',
  'dur-1': '120ms',
  'dur-2': '200ms',
  'dur-3': '320ms',
  'ease-std': 'cubic-bezier(.4, 0, .2, 1)',
  'ease-out': 'cubic-bezier(0, 0, .2, 1)',
  'ease-hard': 'steps(1, end)',
  stagger: '40ms',
  'z-page': '0',
  'z-chrome': '10',
  'z-rail': '20',
  'z-popover': '30',
  'z-sheet': '40',
  'z-toast': '50',
  'z-command': '60',
};
const NARROW: Record<string, string> = { 't-h1': '1.625rem', 't-h2': '1.25rem', 't-h3': '1.0625rem', 'sp-section': '24px' };

/** Quiet's names, each re-pointed at a v3 token until the last surface step deletes the block (spec 2.10). */
const ALIASES: Record<string, string> = {
  bg: 'var(--canvas-1)',
  bar: 'var(--canvas-0)',
  card: 'var(--canvas-2)',
  lane: 'var(--canvas-1)',
  panel: 'var(--canvas-1)',
  float: 'var(--canvas-2)',
  'panel-2': 'var(--canvas-3)',
  track: 'var(--canvas-4)',
  'track-fill': 'var(--text-muted)',
  'text-2': 'var(--text)',
  muted: 'var(--text-muted)',
  faint: 'var(--text-dim)',
  border: 'var(--line)',
  active: 'var(--volt)',
  'active-ink': 'var(--volt)',
  'active-line': 'var(--volt-soft)',
  'active-fill': 'var(--volt-wash)',
  amber: 'var(--volt)',
  'amber-ink': 'var(--volt)',
  'amber-fill': 'var(--volt-wash)',
  red: 'var(--alarm)',
  'red-fill': 'var(--alarm-wash)',
  sky: 'var(--text-hi)',
  link: 'var(--text-hi)',
  shadow: 'none',
  hairline: 'var(--line-strong)',
  radius: '0',
  'font-sans': 'var(--font-body)',
  'fs-l': 'var(--t-title)',
  'fs-m': 'var(--t-body)',
  'fs-s': 'var(--t-detail-sm)',
  'w-text': 'var(--w-body)',
  'w-heavy': 'var(--w-display)',
};

describe('theme', () => {
  it('is dark only: color-scheme dark on :root, and no prefers-color-scheme anywhere in web/src', () => {
    expect(css).toMatch(/^:root\s*\{[^}]*color-scheme:\s*dark;/m);
    const themed = filesUnder('web/src').filter((path) => readFileSync(path, 'utf8').includes('prefers-color-scheme'));
    expect(themed).toEqual([]);
  });

  it("holds v3's colours and the seven factions, in index order", () => {
    for (const [name, value] of Object.entries(COLOUR)) expect(root[name], `--${name}`).toBe(value);
    for (const [name, value] of HUES) expect(root[name], `--${name}`).toBe(value);
    const order = Object.keys(root).filter((name) => name.startsWith('hue-'));
    expect(order).toEqual(HUES.map(([name]) => name));
  });

  it("holds v3's faces, ramp, weights, space, motion and layers, and the steps down under 720 px", () => {
    for (const [name, value] of Object.entries(SCALE)) expect(root[name], `--${name}`).toBe(value);
    expect(narrow).toEqual(NARROW);
  });

  it("re-points every Quiet name at a v3 token, and declares nothing beyond v3's tokens and the aliases", () => {
    for (const [name, value] of Object.entries(ALIASES)) expect(root[name], `--${name}`).toBe(value);
    const known = new Set([...Object.keys(COLOUR), ...HUES.map(([name]) => name), ...Object.keys(SCALE), ...Object.keys(ALIASES)]);
    expect(Object.keys(root).filter((name) => !known.has(name))).toEqual([]);
  });

  it('neither declares nor reads a removed token', () => {
    for (const name of ['accent', 'edge', 'green', 'purple', 'clay', 'track-l']) expect(sheets, `--${name}`).not.toMatch(new RegExp(`--${name}\\b`));
  });

  it('keeps every literal colour in the tokens file', () => {
    const values = [...rules.matchAll(/[\w-]+\s*:\s*([^;{}]+)/g)].map((m) => m[1].trim());
    const literal = values.filter((v) => /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|\b(?:black|white)\b/.test(v));
    expect(literal).toEqual([]);
  });

  it('is square: no border-radius but 0', () => {
    const radii = [...sheets.matchAll(/(?<![\w-])border(?:-[\w]+)*-radius\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(radii.length).toBeGreaterThan(0);
    expect(radii.filter((r) => r !== '0')).toEqual([]);
  });
});

describe('type', () => {
  it('asks only for the weight tokens', () => {
    const weights = [...rules.matchAll(/font-weight:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const allowed = ['var(--w-body)', 'var(--w-strong)', 'var(--w-brand)', 'var(--w-display)', 'var(--w-text)', 'var(--w-heavy)', 'inherit'];
    expect(weights.filter((w) => !allowed.includes(w))).toEqual([]);
  });

  it('sizes text from the ramp, or relative to its parent', () => {
    const sizes = [...rules.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const ramp = ['h1', 'h2', 'h3', 'title', 'body', 'detail-sm', 'micro'].map((t) => `var(--t-${t})`);
    const allowed = [...ramp, 'var(--fs-l)', 'var(--fs-m)', 'var(--fs-s)', 'inherit'];
    expect(sizes.filter((s) => !allowed.includes(s) && !/^[\d.]+em$/.test(s))).toEqual([]);
  });

  it('sets no font shorthand but font: inherit, so size and weight always come from the tokens', () => {
    const shorthands = [...rules.matchAll(/(?<![\w-])font:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(shorthands.filter((f) => f !== 'inherit')).toEqual([]);
  });

  it('stretches a face only to 75, 87.5, 100, 112.5 or 125 %', () => {
    const stretches = [...rules.matchAll(/font-stretch:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(stretches.filter((s) => !['75%', '87.5%', '100%', '112.5%', '125%', 'inherit'].includes(s))).toEqual([]);
  });
});
