import type { CSSProperties } from 'react';
import type { TabItem } from '../parts/TabStrip';

/** Every colour token, grouped as spec 2.3 groups them. A swatch paints `var(--name)`. */
export const COLOUR_GROUPS: { name: string; tokens: string[] }[] = [
  { name: 'Canvas', tokens: ['canvas-0', 'canvas-1', 'canvas-2', 'canvas-3', 'canvas-4'] },
  { name: 'Text', tokens: ['text', 'text-hi', 'text-muted', 'text-dim'] },
  { name: 'Volt', tokens: ['volt', 'volt-ink', 'volt-soft', 'volt-wash'] },
  { name: 'Alarm', tokens: ['alarm', 'alarm-soft', 'alarm-wash'] },
  { name: 'Violet', tokens: ['violet', 'violet-ink'] },
  { name: 'Lines', tokens: ['line-soft', 'line', 'line-strong', 'line-bright'] },
  { name: 'Scrim', tokens: ['scrim'] },
];

/** One row of the type ramp (spec 2.5): the token, its size, what it is for, a sample, and the style the sample is set in. */
export interface RampRow {
  token: string;
  size: string;
  use: string;
  sample: string;
  style: CSSProperties;
}

const display: CSSProperties = { fontFamily: 'var(--font-display)', fontStretch: '125%', fontWeight: 'var(--w-display)', textTransform: 'uppercase' };

export const RAMP: RampRow[] = [
  { token: '--t-h1', size: '2rem (1.625rem under 720 px)', use: 'Page title', sample: 'Ship the window', style: { ...display, fontSize: 'var(--t-h1)', lineHeight: 0.85, letterSpacing: '-0.02em' } },
  { token: '--t-h2', size: '1.5rem (1.25rem under 720 px)', use: 'View title', sample: 'All done', style: { ...display, fontSize: 'var(--t-h2)', lineHeight: 0.85, letterSpacing: '-0.01em' } },
  { token: '--t-h3', size: '1.125rem (1.0625rem under 720 px)', use: 'Column and section heads', sample: 'Needs you', style: { ...display, fontSize: 'var(--t-h3)', lineHeight: 0.9 } },
  { token: '--t-title', size: '1rem', use: 'Task titles, Details title', sample: 'Run the signing tests on a clean build', style: { fontFamily: 'var(--font-body)', fontWeight: 'var(--w-strong)', fontSize: 'var(--t-title)', lineHeight: 1.35 } },
  { token: '--t-body', size: '0.9375rem', use: 'Asks, notes, outcomes, Markdown', sample: 'Which keystore signs the release build?', style: { fontFamily: 'var(--font-body)', fontWeight: 'var(--w-body)', fontSize: 'var(--t-body)', lineHeight: 1.45 } },
  { token: '--t-detail-sm', size: '0.75rem', use: 'Ids, times, meta lines, commands', sample: '#142 updated 09:14 npm run build', style: { fontFamily: 'var(--font-mono)', fontStretch: '87.5%', fontSize: 'var(--t-detail-sm)', lineHeight: 1.2, letterSpacing: '0.04em', fontVariantNumeric: 'slashed-zero tabular-nums' } },
  { token: '--t-micro', size: '0.625rem', use: 'Eyebrows, chips, key caps, readout keys', sample: 'Needs you', style: { fontFamily: 'var(--font-brand)', fontStretch: '112.5%', fontWeight: 'var(--w-brand)', fontSize: 'var(--t-micro)', lineHeight: 1, letterSpacing: '0.08em', textTransform: 'uppercase' } },
];

export const HUE_NAMES = ['Leela', 'Nucal', 'Mida', 'CyberAcme', 'Sekiguchi', 'Traxus', 'Mida-alt'];

export const CHIP_TONES = ['needs', 'live', 'ready', 'blocked', 'parked', 'quiet', 'label', 'count'] as const;
export const CHIP_TEXT: Record<(typeof CHIP_TONES)[number], string> = {
  needs: 'Needs you',
  live: 'Live',
  ready: 'Ready',
  blocked: 'Blocked',
  parked: 'Parked',
  quiet: 'Quiet',
  label: 'ui',
  count: '12 steps',
};
/** The removable chips, restored by Reset. */
export const REMOVABLE_CHIPS = ['ui', 'server', 'docs'];

export const EYEBROW_GLYPHS = ['//', '[+]', '[!]', '>>', '[◈]', '[✓]'] as const;

export const READOUTS: { label: string; value: string; tone: 'text' | 'volt' | 'alarm'; caption: string }[] = [
  { label: 'Steps', value: '42', tone: 'text', caption: 'Text tone' },
  { label: 'Live', value: '3', tone: 'volt', caption: 'Volt tone' },
  { label: 'Blocked', value: '1', tone: 'alarm', caption: 'Alarm tone' },
];
export const LONG_READOUT = 'A long value wraps inside its own box and never pushes the page wider than the window.';

/** The eight phase tabs. Long enough to overflow a 400 px window. */
export const PHASES: TabItem[] = [
  { id: 'phase-plan', label: 'Plan', count: 4 },
  { id: 'phase-design', label: 'Design', count: 9 },
  { id: 'phase-build', label: 'Build', count: 21 },
  { id: 'phase-test', label: 'Test', count: 7 },
  { id: 'phase-review', label: 'Review', count: 3 },
  { id: 'phase-ship', label: 'Ship', count: 5 },
  { id: 'phase-launch', label: 'Launch', count: 2 },
  { id: 'phase-after', label: 'Afterwards', count: 6 },
];
export const SORTS: TabItem[] = [
  { id: 'sort-order', label: 'Order' },
  { id: 'sort-age', label: 'Age' },
  { id: 'sort-name', label: 'Name' },
];

export const MENU_ITEMS: { glyph?: string; label: string; keyHint?: string; current?: boolean; danger?: boolean; disabled?: boolean; separatorBefore?: boolean }[] = [
  { glyph: '›', label: 'Open step', keyHint: 'Enter' },
  { glyph: '+', label: 'Add a step below', current: true },
  { glyph: '↗', label: 'Copy link' },
  { label: 'Move to Backlog', disabled: true },
  { glyph: '×', label: 'Delete step', keyHint: 'Del', danger: true, separatorBefore: true },
];

/** The three columns of the cursor grid: 4, 2 and 5 short tiles of varied title length. */
export const CURSOR_COLUMNS: { id: string; title: string }[][] = [
  [
    { id: '#201', title: 'Sign the build' },
    { id: '#202', title: 'Write the store listing for the first beta, with screenshots' },
    { id: '#203', title: 'Fix the upload' },
    { id: '#204', title: 'Check the keystore is backed up somewhere safe' },
  ],
  [
    { id: '#211', title: 'Pick a launch date' },
    { id: '#212', title: 'Ask the testers which phones they use and what broke' },
  ],
  [
    { id: '#221', title: 'Draft release notes' },
    { id: '#222', title: 'Tag the build' },
    { id: '#223', title: 'Wire the crash reporter into the release build and check it reports' },
    { id: '#224', title: 'Close the beta' },
    { id: '#225', title: 'Thank the testers' },
  ],
];

export const TOAST_TEXT = 'Saved. The step is back in Next.';
export const ALARM_TOAST_TEXT = 'The server did not answer. Your change was not saved.';
export const ERROR_TEXT = 'Could not load the project. The server did not answer.';
export const EMPTY_TEXT = 'Nothing is waiting on you. New questions show up here.';
export const SAMPLE_TITLE = 'Run the signing tests on a clean build';
export const SAMPLE_BODY = 'The upload key must match the one on file with the store before the beta goes out.';
