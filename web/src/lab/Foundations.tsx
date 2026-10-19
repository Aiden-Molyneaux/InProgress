import { Chip } from '../parts/Chip';
import { Count } from '../parts/Count';
import { LiveDot } from '../parts/LiveDot';
import { Tile } from '../parts/Tile';
import { COLOUR_GROUPS, HUE_NAMES, RAMP, SAMPLE_TITLE } from './fixtures';
import { Cell, Section } from './Section';

/** The colour tokens, a swatch each with its name. */
export function TokensSection() {
  return (
    <Section name="Tokens">
      {COLOUR_GROUPS.map((group) => (
        <div key={group.name} className="lab-row">
          {group.tokens.map((token) => (
            <Cell key={token} caption={`--${token}`}>
              <span className="lab-swatch" style={{ background: `var(--${token})` }} />
            </Cell>
          ))}
        </div>
      ))}
    </Section>
  );
}

/** The type ramp, each token set in its own face, weight and case. */
export function RampSection() {
  return (
    <Section name="Type ramp">
      <div className="lab-ramp">
        {RAMP.map((row) => (
          <div key={row.token} className="lab-ramp-row">
            <span className="lab-cap">
              {row.token}, {row.size}. {row.use}.
            </span>
            <span style={row.style}>{row.sample}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** The seven hues as the top rule of a tile, and a tile with none. */
export function HuesSection() {
  return (
    <Section name="Hues">
      <div className="lab-tiles">
        {HUE_NAMES.map((name, hue) => (
          <Cell key={name} caption={`Hue ${hue}, ${name}`}>
            <Tile hue={hue} id={`#${100 + hue}`} title={SAMPLE_TITLE} />
          </Cell>
        ))}
        <Cell caption="No hue">
          <Tile hue={null} id="#107" title={SAMPLE_TITLE} />
        </Cell>
      </div>
    </Section>
  );
}

/** The motion: tiles rising in a stagger, the blink, and a count that strobes when it goes up. Replay replays it. */
export function MotionSection({ round, count }: { round: number; count: number }) {
  return (
    <Section name="Motion">
      <div className="lab-tiles">
        {[0, 1, 2, 3].map((i) => (
          <Cell key={`${round}-${i}`} caption={`Rise ${i}, ${i * 40} ms after the first`}>
            <Tile hue={i} id={`#${110 + i}`} title={SAMPLE_TITLE} rise={i} />
          </Cell>
        ))}
      </div>
      <div className="lab-row">
        <Cell caption="Live chip, blinking">
          <Chip tone="live">Live</Chip>
        </Cell>
        <Cell caption="Live dot, blinking">
          <LiveDot />
        </Cell>
        <Cell caption="Count, strobes once when Replay raises it">
          <Count value={count} />
        </Cell>
      </div>
    </Section>
  );
}
