import { Fragment, useLayoutEffect, useState } from 'react';
import { scrambled } from './scrambled';

export interface PageHeadProps {
  /** The three-letter code block (see `projectCode`). */
  code: string;
  name: string;
  /** The meta line's figures, read as "3 PHASES". */
  meta: { label: string; value: number }[];
  /** What the title decodes for: the project's id. A project decoded once is not decoded again until another one is. */
  decodeKey: number;
}

/** The project the title last decoded for, so a view switch inside one project does not play it again. */
let lastDecoded: number | null = null;

const DECODE_MS = 520;
/** The page head (spec section 7): the code block, the project's name, and the meta line to the right. */
export function PageHead({ code, name, meta, decodeKey }: PageHeadProps) {
  const [shown, setShown] = useState(name);
  // A layout effect, so the name never paints clean before the decode scrambles it.
  useLayoutEffect(() => {
    setShown(name);
    if (lastDecoded === decodeKey) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      lastDecoded = decodeKey;
      return;
    }
    setShown(scrambled(name, 0));
    const letters = [...name].length;
    const started = performance.now();
    let frame = 0;
    const step = (at: number) => {
      const progress = Math.min(1, (at - started) / DECODE_MS);
      setShown(scrambled(name, Math.floor(progress * letters)));
      if (progress < 1) frame = requestAnimationFrame(step);
      else lastDecoded = decodeKey;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [name, decodeKey]);
  return (
    <header className="ip-page-head">
      <span className="ip-page-code" aria-hidden="true">{code}</span>
      <h1 className="ip-page-title" title={name} aria-label={name}>
        <span aria-hidden="true">{shown}</span>
      </h1>
      <p className="ip-page-meta">
        {meta.map((m, i) => (
          <Fragment key={m.label}>
            {i > 0 && <span className="ip-page-sep"> · </span>}
            <span data-zero={m.value === 0 || undefined}>{`${m.value} ${m.label}`}</span>
          </Fragment>
        ))}
      </p>
    </header>
  );
}
