import { useRef, useState } from 'react';
import { answerHeld } from '../api';
import { Button } from '../parts/Button';
import { ErrorLine } from '../parts/ErrorLine';
import { noteAction, type MeasureArea } from '../measure';
import { focusTargetAfter } from './focus';

/**
 * Go ahead and Not yet for one held command (lead stage 1, task D), as AskActions answers an ask: a click sends the answer
 * once (both buttons are inert while it goes and after), a refusal shows under the buttons and focus returns to the button
 * pressed. On success the card strikes through until the stream brings a snapshot without it; focus moves to the next open
 * card in the tile, else to the next row, else to the band's heading.
 */
export function HeldActions({ itemId, area }: { itemId: number; area: MeasureArea }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The answer went out and the snapshot has not dropped the card yet: its buttons are inert (aria-disabled, clicks do nothing). */
  const [sent, setSent] = useState(false);
  const go = useRef<HTMLButtonElement>(null);
  const wait = useRef<HTMLButtonElement>(null);
  const send = async (answer: 'go' | 'not-yet') => {
    if (busy || sent) return;
    const pressed = answer === 'go' ? go.current : wait.current;
    const row = pressed?.closest('li') ?? null;
    const own = pressed?.closest('[data-held]') ?? null;
    const home = row?.closest<HTMLElement>('.ip-band, aside') ?? null;
    /** Where focus goes once this card is answered: another open card in the tile, else the walk to the next row, else the band's heading. */
    const handoff = (): HTMLElement | null => {
      const sibling = row?.isConnected ? [...row.querySelectorAll<HTMLElement>('[data-ask], [data-held]')].find((b) => b !== own && !b.hasAttribute('data-sent')) : undefined;
      const next = sibling?.querySelector<HTMLElement>('[data-answer]');
      if (next) return next;
      if (row?.isConnected) return focusTargetAfter(row);
      return home?.querySelector<HTMLElement>('h2') ?? null;
    };
    noteAction(area, answer === 'go' ? 'held_go' : 'held_not_yet');
    setBusy(true);
    const result = await answerHeld(itemId, answer);
    setBusy(false);
    if (result === 'reload') return window.location.reload();
    if (result === 'ok') {
      own?.setAttribute('data-sent', '');
      setSent(true);
    }
    // Aiden may have moved on while the request ran: focus moves only if it is still on this card's row, or fell to the page.
    const active = document.activeElement;
    if (active && active !== document.body && !row?.contains(active)) {
      if (result !== 'ok') setProblem(result);
      return;
    }
    if (result !== 'ok') {
      setProblem(result);
      pressed?.focus();
    } else handoff()?.focus();
  };
  return (
    <>
      <div className="ip-ask-actions">
        <Button ref={go} variant="primary" size="sm" data-act data-answer aria-disabled={busy || sent} onClick={() => void send('go')}>
          Go ahead
        </Button>
        <Button ref={wait} variant="ghost" size="sm" data-act aria-disabled={busy || sent} onClick={() => void send('not-yet')}>
          Not yet
        </Button>
      </div>
      {problem && <ErrorLine message={problem} role="alert" />}
    </>
  );
}
