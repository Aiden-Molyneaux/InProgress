import { Count } from '../parts/Count';

export type Band = 'needs' | 'next' | 'now' | 'done';

export const BAND_LABEL: Record<Band, string> = { needs: 'Needs me', next: 'Next', now: 'Now', done: 'Done' };
const GLYPH: Record<Band, string> = { needs: '[!]', next: '>>', now: '[◈]', done: '[✓]' };

/** A column's head: its glyph, its name (a heading focus can land on), a hint under it, and how many tiles it holds. */
export function ColumnHead({ band, count, hint }: { band: Band; count: number; hint: string }) {
  return (
    <header className="ip-col-head" data-band={band}>
      <div className="ip-col-title">
        <span className="ip-col-glyph" aria-hidden="true">{GLYPH[band]}</span>
        <h2 tabIndex={-1}>{BAND_LABEL[band]}</h2>
      </div>
      <p className="ip-col-hint" title={hint}>{hint}</p>
      <Count value={count} size="h3" tone={band === 'needs' ? 'volt' : 'muted'} />
    </header>
  );
}
