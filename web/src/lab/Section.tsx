import { useId, type ReactNode } from 'react';
import { Eyebrow } from '../parts/Eyebrow';

/** One part's section on the lab page: its name as a heading, then its specimens. */
export function Section({ name, children }: { name: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="lab-part" aria-labelledby={id}>
      <Eyebrow as="h2" glyph="//" id={id}>
        {name}
      </Eyebrow>
      {children}
    </section>
  );
}

/** One specimen with a caption naming the variant or state it shows. */
export function Cell({ caption, children, className }: { caption: string; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `lab-cell ${className}` : 'lab-cell'}>
      {children}
      <span className="lab-cap">{caption}</span>
    </div>
  );
}
