import type { NodeStatus } from '../../src/core/types';
import './character.css';

export interface MarkerProps {
  status: NodeStatus;
  /** node.kind === 'question': the ? disc. A done question keeps the ?. */
  question: boolean;
  /** LayoutNodeItem.paused: the hollow sky ring. */
  paused: boolean;
  /** isNeedsYou(node): the amber dot. */
  needsYou: boolean;
  /** LayoutNodeItem.working: an active marker pulses (ip-pulse). Details passes false. */
  pulse: boolean;
  /** The card passes `Nobody is on this. Last change ${lastChange}` when paused. */
  title?: string;
}

/**
 * A step's status marker, on a card's header and in Details' step list. Its look is in character.css, which also draws
 * the done ✓ and the question's ?, so the span holds no text and a step's name stays the first text beside it.
 */
export function Marker({ status, question, paused, needsYou, pulse, title }: MarkerProps) {
  return (
    <span
      className={['ip-marker', `m-${status}`, question && 'q', paused && 'm-paused', needsYou && 'm-you', pulse && 'm-pulse'].filter(Boolean).join(' ')}
      title={title}
    />
  );
}
