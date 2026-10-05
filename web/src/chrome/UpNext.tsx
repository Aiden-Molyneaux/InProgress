import { Fragment, type KeyboardEvent } from 'react';
import { queueView } from '../../../src/core/layout';
import type { QueueEntry, TreeNode } from '../../../src/core/types';
import { circled } from '../live';

interface UpNextProps {
  /** The project's queue, next first. */
  queue: QueueEntry[];
  nodes: TreeNode[];
  /** Brings a step into view. */
  onJump: (id: number) => void;
}

/**
 * `Up next: ① #42 Title · ② #44 Title …`, the order Claude plans to work in. Each step jumps to its row. One line, cut
 * short at the window's edge; nothing at all while the queue is empty.
 */
export function UpNext({ queue, nodes, onJump }: UpNextProps) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const steps = queueView(queue, nodes, []).unowned.map((id) => byId.get(id)!);
  if (!steps.length) return null;
  const label = (n: TreeNode, i: number) => `${circled(i + 1)} #${n.id} ${n.title}`;
  // Inline spans, not buttons, so the line cuts a title short with an ellipsis instead of hiding a whole step.
  const onKeyDown = (e: KeyboardEvent, id: number) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onJump(id);
  };
  return (
    <div className="ip-upnext" title={`Up next: ${steps.map(label).join(' · ')}`}>
      <span className="ip-upnext-label">Up next:</span>{' '}
      {steps.map((n, i) => (
        <Fragment key={n.id}>
          {i > 0 && ' · '}
          <span role="button" tabIndex={0} className="ip-upnext-item" onClick={() => onJump(n.id)} onKeyDown={(e) => onKeyDown(e, n.id)}>
            {label(n, i)}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
