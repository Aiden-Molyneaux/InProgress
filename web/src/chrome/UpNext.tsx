import { Fragment, type CSSProperties, type KeyboardEvent } from 'react';
import { queueView } from '../../../src/core/layout';
import { ownerTag, type QueueEntry, type Session, type TreeNode } from '../../../src/core/types';
import { familyVar } from '../family';
import { circled } from '../live';

interface UpNextProps {
  /** The project's queue, as stored: owned entries first, next first. */
  queue: readonly QueueEntry[];
  nodes: TreeNode[];
  /** The project's live sessions: each one's letter and hue lead its line, and its focus stays out of its list. */
  sessions: Session[];
  /** Brings a step into view. */
  onJump: (id: number) => void;
}

/**
 * The order Claude plans to work in, as Aiden reads it at a glance:
 *
 *     UP NEXT  A      ① #82 Trail of ended work · ② #78 Guide
 *              B      ① #90 Owned queue entries
 *              later  ① #79 Taskbar icon
 *
 * The head sits once in a left column. Beside it, one line per live session that has steps, in the queue's order, led
 * by its letter in its family's hue (`?` while its slot is empty), then one neutral `later` line for the unowned steps.
 * Each line is numbered as the markers on the cards are, and cut short at the window's edge; each step jumps to its
 * row. Nothing at all while no step is up next.
 */
export function UpNext({ queue, nodes, sessions, onJump }: UpNextProps) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const slotOf = new Map(sessions.map((s) => [s.id, s.slot]));
  const view = queueView(queue, nodes, sessions);
  const lines = [
    ...[...view.bySession].map(([id, ids]) => ({ key: `s:${id}`, lead: ownerTag(slotOf.get(id) ?? null), slot: slotOf.get(id) ?? null, owned: true, ids })),
    ...(view.unowned.length ? [{ key: 'later', lead: 'later', slot: null, owned: false, ids: view.unowned }] : []),
  ];
  if (!lines.length) return null;
  const label = (n: TreeNode, i: number) => `${circled(i + 1)} #${n.id} ${n.title}`;
  // Inline spans, not buttons, so a line cuts a title short with an ellipsis instead of hiding a whole step.
  const onKeyDown = (e: KeyboardEvent, id: number) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onJump(id);
  };
  return (
    <div className="ip-upnext">
      <div className="ip-upnext-head">Up next</div>
      <div className="ip-upnext-lines">
        {lines.map((line) => {
          const steps = line.ids.map((id) => byId.get(id)!);
          return (
            <div
              key={line.key}
              className={`ip-upnext-line${line.owned ? ' owned' : ''}`}
              style={line.owned ? ({ '--fam': familyVar(line.slot) } as CSSProperties) : undefined}
              title={`${line.lead}: ${steps.map(label).join(' · ')}`}
            >
              <span className="ip-upnext-lead">{line.lead}</span>{' '}
              {steps.map((n, i) => (
                <Fragment key={n.id}>
                  {i > 0 && <span className="ip-upnext-sep"> · </span>}
                  {/* The spaces stay literal, so the step's text and name read `① #82 Title` as before. */}
                  <span role="button" tabIndex={0} className="ip-upnext-item" onClick={() => onJump(n.id)} onKeyDown={(e) => onKeyDown(e, n.id)}>
                    {circled(i + 1)} <span className="ip-upnext-id">#{n.id}</span> <span className="ip-upnext-title">{n.title}</span>
                  </span>
                </Fragment>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
