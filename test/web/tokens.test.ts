import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The stylesheet with its comments taken out, so a comment can never pass for a rule. */
const css = readFileSync('web/src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties a block declares: name (without the --) to value. */
function tokens(body: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (body ?? '').matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** The first :root block holds the day; the one inside the dark media query holds the night. */
const day = tokens(/:root\s*\{([^}]*)\}/.exec(css)?.[1]);
const night = tokens(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1]);

/** One value for day and night: these live in :root only. */
const THEME_FREE: Record<string, string> = {
  radius: '8px',
  hairline: 'linear-gradient(97deg, #6366f1, #ff6600)',
  'font-sans': "'Inter', system-ui, 'Segoe UI', 'Segoe UI Symbol', sans-serif",
  'font-mono': "'DM Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
  'fs-l': '15px',
  'fs-m': '12.5px',
  'fs-s': '11px',
  'w-text': '500',
  'w-heavy': '900',
  'track-l': '-0.05em',
};

/** Quiet's colour tokens as [day, night]. */
const QUIET: Record<string, [string, string]> = {
  bg: ['#f8fafc', '#080d1c'],
  text: ['#0f172a', '#f1f5f9'],
  'text-2': ['#1e293b', '#e2e8f0'],
  muted: ['#475569', '#94a3b8'],
  faint: ['#64748b', '#64748b'],
  border: ['rgba(15,23,42,.11)', 'rgba(255,255,255,.09)'],
  bar: ['#ffffff', 'rgba(255,255,255,.018)'],
  card: ['#ffffff', 'rgba(255,255,255,.035)'],
  'active-fill': ['#fffaf6', 'rgba(249,115,22,.045)'],
  lane: ['rgba(15,23,42,.018)', 'rgba(255,255,255,.022)'],
  float: ['rgba(248,250,252,.94)', 'rgba(8,13,28,.92)'],
  panel: ['#ffffff', '#0c1227'],
  shadow: ['0 8px 24px rgba(15,23,42,.16)', '0 8px 24px rgba(0,0,0,.55)'],
  'panel-2': ['rgba(15,23,42,.05)', 'rgba(255,255,255,.06)'],
  track: ['rgba(15,23,42,.08)', 'rgba(255,255,255,.08)'],
  'track-fill': ['rgba(71,85,105,.5)', 'rgba(148,163,184,.55)'],
  active: ['#c2410c', '#f97316'],
  'active-ink': ['#c2410c', '#fb923c'],
  'active-line': ['rgba(234,88,12,.55)', 'rgba(249,115,22,.5)'],
  sky: ['#0284c7', '#38bdf8'],
  link: ['#0369a1', '#38bdf8'],
  amber: ['#d97706', '#fbbf24'],
  'amber-ink': ['#92400e', '#fcd34d'],
  'amber-fill': ['rgba(251,191,36,.18)', 'rgba(251,191,36,.12)'],
  red: ['#b91c1c', '#f87171'],
  'red-fill': ['rgba(185,28,28,.08)', 'rgba(248,113,113,.1)'],
};

/** The seven task hues of the Board's boxes as [day, night]: none is orange, yellow, red or grey, which states own. */
const TASK_HUES: Record<string, [string, string]> = {
  'hue-0': ['#0e7490', '#22d3ee'],
  'hue-1': ['#2563eb', '#60a5fa'],
  'hue-2': ['#4f46e5', '#818cf8'],
  'hue-3': ['#9333ea', '#c084fc'],
  'hue-4': ['#db2777', '#f472b6'],
  'hue-5': ['#15803d', '#4ade80'],
  'hue-6': ['#8b5e34', '#d4a574'],
};

describe('theme tokens', () => {
  it('follows the system theme: day in :root, night in the one dark block', () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light dark;/);
    expect(css.match(/@media \(prefers-color-scheme: dark\)/g)).toHaveLength(1);
    expect(Object.keys(day).length).toBeGreaterThan(0);
    expect(Object.keys(night).length).toBeGreaterThan(0);
  });

  it('gives every colour token in :root a night value in the dark block', () => {
    const colour = Object.keys(day).filter((name) => !(name in THEME_FREE));
    expect(colour.filter((name) => !(name in night))).toEqual([]);
  });

  it('declares nothing at night that the day lacks, and leaves the theme-free tokens to :root', () => {
    expect(Object.keys(night).filter((name) => !(name in day))).toEqual([]);
    expect(Object.keys(THEME_FREE).filter((name) => name in night)).toEqual([]);
  });

  it("holds Quiet's values, and no colour token beyond them and the seven task hues", () => {
    for (const [name, [d, n]] of Object.entries(QUIET)) {
      expect(day[name], `--${name} by day`).toBe(d);
      expect(night[name], `--${name} by night`).toBe(n);
    }
    for (const [name, [d, n]] of Object.entries(TASK_HUES)) {
      expect(day[name], `--${name} by day`).toBe(d);
      expect(night[name], `--${name} by night`).toBe(n);
    }
    const unknown = Object.keys(day).filter((name) => !(name in QUIET) && !(name in TASK_HUES) && !(name in THEME_FREE));
    expect(unknown).toEqual([]);
  });

  it('holds the theme-free values in :root', () => {
    for (const [name, value] of Object.entries(THEME_FREE)) expect(day[name], `--${name}`).toBe(value);
  });

  it('neither declares nor reads a removed token', () => {
    for (const name of ['accent', 'edge', 'green', 'purple', 'clay']) expect(css, `--${name}`).not.toMatch(new RegExp(`--${name}\\b`));
  });
});

describe('type', () => {
  it('asks only for the two weights that ship, 500 and 900', () => {
    const weights = [...css.matchAll(/font-weight:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const allowed = ['500', '900', 'var(--w-text)', 'var(--w-heavy)', 'inherit'];
    expect(weights.filter((w) => !allowed.includes(w))).toEqual([]);
  });

  it('sizes text L, M or S, or relative to its parent', () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const allowed = ['15px', '12.5px', '11px', 'var(--fs-l)', 'var(--fs-m)', 'var(--fs-s)', 'inherit'];
    expect(sizes.filter((s) => !allowed.includes(s) && !/^[\d.]+em$/.test(s))).toEqual([]);
  });
});
