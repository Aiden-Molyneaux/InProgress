import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { deleteStep } from '../api';
import { noteAction } from '../measure';
import { load, save } from '../storage';
import { backlogSections, type BacklogOrder, ORDER_KEY, orderKey, parentTitle, parseOrder } from './backlogOrder';
import { focusTargetAfter } from './focus';
import { endedLine } from './Marks';
import type { BandProps } from './bandProps';
import { TaskBox } from './TaskBox';

/**
 * The open Backlog: task boxes with no hue under their parent's title, each draggable, with "to Next" and "Delete…" shown
 * on hover and on focus. "Delete…" opens its confirm inside the box. A control on top orders the rows by phase (under
 * each parent) or by id (one flat list, each box naming its parent), forward or reverse (#452).
 */
export function Backlog({ boxes, snapshot, now, projectId, slug, onStatus, onOpenNode, onOpenResource, onDragStart, onDragEnd, onToNext }: Pick<BandProps, 'snapshot' | 'now' | 'onOpenNode' | 'onOpenResource' | 'onStatus'> & {
  boxes: BoxData[];
  projectId: number;
  slug: string;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onToNext: (id: number) => void;
}) {
  /** The row whose Delete confirm is open: one at a time. */
  const [confirming, setConfirming] = useState<number | null>(null);
  /** Rows deleted and waiting for the answer, or for the snapshot that drops them. */
  const [pending, setPending] = useState<number[]>([]);
  const [order, setOrder] = useState<BacklogOrder>(() => parseOrder(load(ORDER_KEY)));
  const pick = (o: BacklogOrder) => {
    setOrder(o);
    save(ORDER_KEY, orderKey(o));
  };
  const root = useRef<HTMLDivElement>(null);
  /** The band heading, for when the confirm's row leaves and takes focus with it. */
  const heading = useRef<HTMLElement | null>(null);
  const ids = boxes.map((b) => b.row!.node.id).join(',');
  // Cancel takes focus when a confirm opens.
  useEffect(() => {
    if (confirming === null) return;
    const home = root.current?.closest<HTMLElement>('.ip-band');
    heading.current = home?.querySelector<HTMLElement>('h3, header b') ?? null;
    root.current?.querySelector<HTMLElement>('.ip-confirm [data-cancel]')?.focus();
  }, [confirming]);
  // A row that left (deleted here or elsewhere) no longer confirms or waits; if it took focus with it, the heading has it.
  useEffect(() => {
    const here = new Set(ids ? ids.split(',').map(Number) : []);
    if (confirming !== null && !here.has(confirming)) {
      setConfirming(null);
      if (document.activeElement === document.body) heading.current?.focus();
    }
    setPending((p) => (p.some((id) => !here.has(id)) ? p.filter((id) => here.has(id)) : p));
  }, [ids, confirming]);
  /** Puts focus back on that row's Delete button, once it is drawn again. */
  const refocus = (id: number) => window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`li[data-node="${id}"] [data-delete]`)?.focus());
  const cancel = (id: number) => {
    setConfirming(null);
    refocus(id);
  };
  const remove = async (id: number, li: HTMLElement | null) => {
    noteAction('backlog', 'delete');
    const after = focusTargetAfter(li);
    setConfirming(null);
    setPending((p) => [...p, id]);
    after?.focus();
    const result = await deleteStep(projectId, slug, id);
    if (result === 'ok') return;
    // Drawn at once, so the row's Delete button is there to focus; and only when focus has not moved on meanwhile.
    flushSync(() => setPending((p) => p.filter((x) => x !== id)));
    if (!after || document.activeElement === after) root.current?.querySelector<HTMLElement>(`li[data-node="${id}"] [data-delete]`)?.focus();
    if (result === 'reload') window.location.reload();
    else onStatus?.(result);
  };
  if (boxes.length === 0) return <p className="ip-quiet ip-empty-line">Backlog is empty</p>;
  /** The server refuses a step with any step under it, done or dropped ones too. */
  const parents = new Set(snapshot.nodes.map((n) => n.parentId));
  const hasKids = (id: number) => parents.has(id);
  return (
    <div className="ip-backlog-groups" ref={root}>
      <div className="ip-backlog-order" role="group" aria-label="Backlog order">
        <button type="button" aria-pressed={order.by === 'phase'} onClick={() => pick({ ...order, by: 'phase' })}>Phase</button>
        <button type="button" aria-pressed={order.by === 'id'} onClick={() => pick({ ...order, by: 'id' })}>ID</button>
        <button type="button" aria-label="Reverse" title={order.reverse ? 'Reverse order' : 'Forward order'} aria-pressed={order.reverse} onClick={() => pick({ ...order, reverse: !order.reverse })}>
          {order.reverse ? '↓' : '↑'}
        </button>
      </div>
      {backlogSections(boxes, order).map((g) => (
        <section
          key={g.flat ? 'id' : (g.parent?.id ?? 0)}
          className="ip-backlog-group"
          aria-label={g.flat ? 'Backlog by id' : g.parent ? `Backlog under ${g.parent.title}` : 'Backlog at the top level'}
        >
          {g.parent && <div className="ip-group-line" title={g.parent.title}>{g.parent.title}</div>}
          <ul className="ip-list">
            {g.boxes.map((box) => {
              const row = box.row!;
              const asking = confirming === row.node.id;
              const waiting = pending.includes(row.node.id);
              return (
                <TaskBox
                  key={row.node.id}
                  box={box}
                  now={now}
                  area="backlog"
                  docs={snapshot.resources.filter((r) => r.nodeId === row.node.id).length}
                  system={endedLine(row, snapshot.pastSessions, now)}
                  className={`ip-backlog-row${waiting ? ' pending' : ''}${asking ? ' confirming' : ''}`}
                  noHue
                  still={asking || waiting}
                  li={{
                    'aria-busy': waiting || undefined,
                    draggable: !asking && !waiting,
                    onDragStart: (e) => {
                      if (asking || waiting) return e.preventDefault();
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(row.node.id));
                      onDragStart(row.node.id);
                    },
                    onDragEnd,
                    // A press on the confirming box outside the confirm's buttons puts focus in the confirm (or keeps it
                    // there), so Escape still closes it.
                    onMouseDown: asking ? (e) => {
                      if ((e.target as HTMLElement).closest('.ip-confirm button')) return;
                      e.preventDefault();
                      const confirm = e.currentTarget.querySelector<HTMLElement>('.ip-confirm');
                      if (confirm && !confirm.contains(document.activeElement)) confirm.focus();
                    } : undefined,
                    // Escape anywhere in the confirming box closes the confirm.
                    onKeyDown: asking ? (e) => {
                      if (e.key !== 'Escape') return;
                      e.stopPropagation();
                      cancel(row.node.id);
                    } : undefined,
                  }}
                  extra={asking ? undefined : (
                    <>
                      <button type="button" className="ip-hover-act" data-act onClick={(e) => {
                        noteAction('backlog', 'to_next');
                        focusTargetAfter(e.currentTarget.closest('li'))?.focus();
                        onToNext(row.node.id);
                      }}>to Next</button>
                      {!hasKids(row.node.id) && (
                        <button type="button" className="ip-hover-act" data-act data-delete aria-haspopup="dialog" onClick={() => setConfirming(row.node.id)}>Delete…</button>
                      )}
                    </>
                  )}
                  onOpenNode={onOpenNode}
                  onOpenResource={onOpenResource}
                >
                  {g.flat && parentTitle(box) && <div className="ip-group-line ip-box-parent" title={parentTitle(box)!}>{parentTitle(box)}</div>}
                  {asking && (
                    <div
                      className="ip-confirm"
                      role="dialog"
                      aria-modal={false}
                      aria-labelledby={`bl${row.node.id}q`}
                      aria-describedby={`bl${row.node.id}d`}
                      tabIndex={-1}
                      data-act
                    >
                      <b id={`bl${row.node.id}q`}>Delete #{row.node.id} {row.node.title}?</b>
                      <p id={`bl${row.node.id}d`}>It can't be undone.</p>
                      <div>
                        <button type="button" className="ip-btn go" onClick={(e) => void remove(row.node.id, e.currentTarget.closest('li'))}>
                          Delete
                        </button>
                        <button type="button" className="ip-btn" data-cancel onClick={() => cancel(row.node.id)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </TaskBox>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
