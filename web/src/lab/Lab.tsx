import { useEffect, useState } from 'react';
import '../styles/lab.css';
import { Button } from '../parts/Button';
import { Eyebrow } from '../parts/Eyebrow';
import { HuesSection, MotionSection, RampSection, TokensSection } from './Foundations';
import { ButtonSection, CountSection, EmptyStateSection, ErrorLineSection, EyebrowSection, FrameSection, KeyHintSection, LiveDotSection, MarkerSection, ReadoutSection, RulerSection, TapeSection } from './StaticParts';
import { ChipSection, ConfirmSection, FieldSection, ListCursorSection, MenuSection, TabStripSection, TileSection, ToastSection } from './InteractiveParts';

/**
 * The parts lab: every shared part in every state, from fixtures. Reached only by typing `#/lab`; nothing links to it, and
 * it reads nothing from the server. Replay remounts the rising tiles and raises the demo count, to see the motion again.
 */
export default function Lab() {
  const [round, setRound] = useState(0);
  const [count, setCount] = useState(7);
  useEffect(() => {
    const before = document.title;
    document.title = 'Parts lab · InProgress';
    return () => {
      document.title = before;
    };
  }, []);
  return (
    <main className="lab">
      <header className="lab-head">
        <Eyebrow glyph="[◈]">Dev only</Eyebrow>
        <h1 className="lab-title">Parts lab</h1>
        <p className="lab-lede">Every v3 part in every state, from fixtures. Reached only by typing #/lab.</p>
        <div>
          <Button
            size="sm"
            onClick={() => {
              setRound((n) => n + 1);
              setCount((n) => n + 1);
            }}
          >
            Replay
          </Button>
        </div>
      </header>
      <TokensSection />
      <RampSection />
      <HuesSection />
      <MotionSection round={round} count={count} />
      <EyebrowSection />
      <ReadoutSection />
      <CountSection />
      <ChipSection />
      <ButtonSection />
      <TabStripSection />
      <FieldSection />
      <MenuSection />
      <ConfirmSection />
      <TileSection />
      <FrameSection />
      <LiveDotSection />
      <MarkerSection />
      <KeyHintSection />
      <TapeSection />
      <RulerSection />
      <EmptyStateSection />
      <ErrorLineSection />
      <ToastSection />
      <ListCursorSection />
    </main>
  );
}
