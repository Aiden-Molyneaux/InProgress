import type { ReactNode } from 'react';
import { Eyebrow } from '../parts/Eyebrow';

export interface CommsSlabProps {
  /** How long ago the note was written, as `ageShort` gives it ("now", "5m", "2d"); null when there is no note. */
  age: string | null;
  /** The body: the note. */
  children: ReactNode;
  /** At the right of the first row. */
  actions?: ReactNode;
  /** A second row under the body. */
  below?: ReactNode;
}

/** The slab that speaks for the whole window (spec section 7): the orchestrator's note. */
export function CommsSlab({ age, children, actions, below }: CommsSlabProps) {
  return (
    <section className="ip-comms" aria-label="Orchestrator note">
      <div className="ip-comms-inner">
        <div className="ip-comms-row">
          <Eyebrow glyph="[◈]">COMMS // ORCHESTRATOR</Eyebrow>
          {age && <span className="ip-comms-age">{age === 'now' ? 'LOOKED JUST NOW' : `LOOKED ${age.toUpperCase()} AGO`}</span>}
          {actions && <span className="ip-comms-actions">{actions}</span>}
        </div>
        <div className="ip-comms-body">{children}</div>
        {below}
      </div>
    </section>
  );
}
