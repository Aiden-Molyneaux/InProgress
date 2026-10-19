import type { NodeStatus } from '../../../src/core/types';
import { Button } from '../parts/Button';
import { Count } from '../parts/Count';
import { EmptyState } from '../parts/EmptyState';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
import { Frame } from '../parts/Frame';
import { KeyHint } from '../parts/KeyHint';
import { LiveDot } from '../parts/LiveDot';
import { Marker } from '../parts/Marker';
import { Readout } from '../parts/Readout';
import { Ruler } from '../parts/Ruler';
import { Tape } from '../parts/Tape';
import { EMPTY_TEXT, ERROR_TEXT, EYEBROW_GLYPHS, LONG_READOUT, READOUTS } from './fixtures';
import { Cell, Section } from './Section';

/** Every Eyebrow glyph, in both glyph tones. */
export function EyebrowSection() {
  return (
    <Section name="Eyebrow">
      <div className="lab-row">
        {EYEBROW_GLYPHS.map((glyph) => (
          <Cell key={glyph} caption={`Glyph ${glyph}, volt`}>
            <Eyebrow glyph={glyph}>Needs you</Eyebrow>
          </Cell>
        ))}
      </div>
      <div className="lab-row">
        {EYEBROW_GLYPHS.map((glyph) => (
          <Cell key={glyph} caption={`Glyph ${glyph}, dim`}>
            <Eyebrow glyph={glyph} glyphTone="dim">
              Next
            </Eyebrow>
          </Cell>
        ))}
        <Cell caption="No glyph">
          <Eyebrow>Dev only</Eyebrow>
        </Cell>
      </div>
    </Section>
  );
}

/** Each Readout tone, the dot face and a long value. */
export function ReadoutSection() {
  return (
    <Section name="Readout">
      <div className="lab-row">
        {READOUTS.map((r) => (
          <Cell key={r.label} caption={r.caption}>
            <Readout label={r.label} value={r.value} tone={r.tone} />
          </Cell>
        ))}
        <Cell caption="Dot face">
          <Readout label="Asks" value="07" face="dot" tone="volt" />
        </Cell>
        <Cell caption="A long value">
          <Readout label="Note" value={LONG_READOUT} />
        </Cell>
      </div>
    </Section>
  );
}

/** Both Count sizes in each tone. */
export function CountSection() {
  return (
    <Section name="Count">
      <div className="lab-row">
        {(['muted', 'text', 'volt'] as const).map((tone) => (
          <Cell key={tone} caption={`Size h1, ${tone}`}>
            <Count value={12} tone={tone} />
          </Cell>
        ))}
        {(['muted', 'text', 'volt'] as const).map((tone) => (
          <Cell key={tone} caption={`Size h3, ${tone}`}>
            <Count value={12} size="h3" tone={tone} />
          </Cell>
        ))}
      </div>
    </Section>
  );
}

/** Every Button variant at both sizes, then a glyph, busy and disabled. */
export function ButtonSection() {
  return (
    <Section name="Button">
      {(['sm', 'md'] as const).map((size) => (
        <div key={size} className="lab-row">
          {(['primary', 'outline', 'ghost', 'danger'] as const).map((variant) => (
            <Cell key={variant} caption={`${variant}, ${size}`}>
              <Button variant={variant} size={size}>
                {variant === 'danger' ? 'Delete' : 'Send'}
              </Button>
            </Cell>
          ))}
        </div>
      ))}
      <div className="lab-row">
        <Cell caption="Glyph ›">
          <Button glyph="›">Open</Button>
        </Cell>
        <Cell caption="Glyph ↗">
          <Button glyph="↗" variant="primary">
            Open in browser
          </Button>
        </Cell>
        <Cell caption="Busy">
          <Button busy>Saving</Button>
        </Cell>
        <Cell caption="Busy, primary">
          <Button busy variant="primary">
            Sending
          </Button>
        </Cell>
        <Cell caption="Disabled">
          <Button disabled>Send</Button>
        </Cell>
        <Cell caption="Disabled, primary">
          <Button disabled variant="primary">
            Send
          </Button>
        </Cell>
        <Cell caption="Disabled, danger">
          <Button disabled variant="danger">
            Delete
          </Button>
        </Cell>
      </div>
    </Section>
  );
}

/** Volt and alarm brackets around a plain box. */
export function FrameSection() {
  return (
    <Section name="Frame">
      <div className="lab-row">
        {(['volt', 'alarm'] as const).map((tone) => (
          <Cell key={tone} caption={`Tone ${tone}`}>
            <div className="lab-framed">
              A plain box
              <Frame tone={tone} />
            </div>
          </Cell>
        ))}
      </div>
    </Section>
  );
}

/** The live dot blinking and still. */
export function LiveDotSection() {
  return (
    <Section name="LiveDot">
      <div className="lab-row">
        <Cell caption="Blinking">
          <LiveDot />
        </Cell>
        <Cell caption="Still">
          <LiveDot still />
        </Cell>
      </div>
    </Section>
  );
}

const STATUSES: NodeStatus[] = ['todo', 'active', 'done', 'blocked', 'dropped', 'parked'];

/** One Marker beside its caption, as a step line. */
function Step({ caption, ...flags }: { caption: string; status: NodeStatus; question?: boolean; paused?: boolean; needsYou?: boolean; pulse?: boolean }) {
  return (
    <div className="lab-step">
      <Marker status={flags.status} question={!!flags.question} paused={!!flags.paused} needsYou={!!flags.needsYou} pulse={!!flags.pulse} />
      <span className="lab-cap">{caption}</span>
    </div>
  );
}

/** Every status, a question, paused, yours, and the combinations. */
export function MarkerSection() {
  return (
    <Section name="Marker">
      <div className="lab-row">
        {STATUSES.map((status) => (
          <Step key={status} status={status} caption={`Status ${status}`} />
        ))}
      </div>
      <div className="lab-row">
        <Step status="active" question caption="Question" />
        <Step status="done" question caption="Question, done" />
        <Step status="active" paused caption="Paused" />
        <Step status="active" needsYou caption="Yours" />
        <Step status="active" question paused caption="Question, paused" />
        <Step status="active" question needsYou caption="Question, yours" />
        <Step status="active" pulse caption="Active, pulsing" />
      </div>
    </Section>
  );
}

/** Key hints as a footer or a menu shows them. */
export function KeyHintSection() {
  return (
    <Section name="KeyHint">
      <div className="lab-row">
        <Cell caption="Two keys">
          <KeyHint keys={['Ctrl', 'K']} label="Go to" />
        </Cell>
        <Cell caption="One key">
          <KeyHint keys={['Esc']} label="Close" />
        </Cell>
        <Cell caption="Arrows">
          <KeyHint keys={['↑', '↓']} label="Move" />
        </Cell>
      </div>
    </Section>
  );
}

/** Volt and alarm tape. */
export function TapeSection() {
  return (
    <Section name="Tape">
      <div className="lab-stack">
        <Cell caption="Volt">
          <Tape />
        </Cell>
        <Cell caption="Alarm">
          <Tape tone="alarm" />
        </Cell>
      </div>
    </Section>
  );
}

/** The bar's ruler and the "since" rule. */
export function RulerSection() {
  return (
    <Section name="Ruler">
      <div className="lab-stack">
        <Cell caption="Hud">
          <Ruler />
        </Cell>
        <Cell caption="Since">
          <Ruler variant="since" label="Since 09:14" />
        </Cell>
      </div>
    </Section>
  );
}

/** An empty list with and without an action. */
export function EmptyStateSection() {
  return (
    <Section name="EmptyState">
      <div className="lab-stack">
        <Cell caption="With an action">
          <EmptyState action={<Button size="sm">Add a step</Button>}>{EMPTY_TEXT}</EmptyState>
        </Cell>
        <Cell caption="Without an action">
          <EmptyState>{EMPTY_TEXT}</EmptyState>
        </Cell>
      </div>
    </Section>
  );
}

/** A failure line with and without Retry. */
export function ErrorLineSection() {
  return (
    <Section name="ErrorLine">
      <div className="lab-stack">
        <Cell caption="With Retry">
          <ErrorLine message={ERROR_TEXT} onRetry={() => undefined} />
        </Cell>
        <Cell caption="Without Retry">
          <ErrorLine message={ERROR_TEXT} />
        </Cell>
      </div>
    </Section>
  );
}
