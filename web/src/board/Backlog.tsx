import type { BoardRow } from '../../../src/core/board';
import type { TreeNode } from '../../../src/core/types';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { deleteStep } from '../api';
import { noteAction } from '../measure';
import { focusTargetAfter } from './focus';
import { endedLine, LabelChip, rowClick, StepMarks } from './Marks';
import type { BandProps } from './bandProps';

/** Backlog rows grouped by parent, in the order the parents first appear; rows at the top level come first with no line. */
export function groupByParent(rows: BoardRow[]): { parent: TreeNode | null; rows: BoardRow[] }[] {
  const groups = new Map<number, { parent: TreeNode | null; rows: BoardRow[] }>();
  for (const row of rows) {
    const parent = row.crumb[row.crumb.length - 1] ?? null;
    const key = parent?.id ?? 0;
    const group = groups.get(key) ?? { parent, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === 0 ? 0 : 1) - (b === 0 ? 0 : 1)).map(([, g]) => g);
}

/** The open Backlog: one-line rows under their parent's title, each draggable, with "to Next" shown on hover and on focus. */
export function Backlog({ rows, snapshot, now, projectId, slug, onStatus, onOpenNode, onOpenResource, onDragStart, onDragEnd, onToNext }: Pick<BandProps, 'snapshot' | 'now' | 'onOpenNode' | 'onOpenResource' | 'onStatus'> & {
  rows: BoardRow[];
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
  const root = useRef<HTMLDivElement>(null);
  /** The band heading, for when the confirm's row leaves and takes focus with it. */
  const heading = useRef<HTMLElement | null>(null);
  const ids = rows.map((r) => r.node.id).join(',');
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
  if (rows.length === 0) return <p className="ip-quiet ip-empty-line">Backlog is empty</p>;
  /** The server refuses a step with any step under it, done or dropped ones too. */
  const parents = new Set(snapshot.nodes.map((n) => n.parentId));
  const hasKids = (id: number) => parents.has(id);
  return (
    <div className="ip-backlog-groups" ref={root}>
      {groupByParent(rows).map((g) => (
        <section key={g.parent?.id ?? 0} className="ip-backlog-group" aria-label={g.parent ? `Backlog under ${g.parent.title}` : 'Backlog at the top level'}>
          {g.parent && <div className="ip-group-line" title={g.parent.title}>{g.parent.title}</div>}
          <ul>
            {g.rows.map((row) => {
              const ended = endedLine(row, snapshot.pastSessions, now);
              const asking = confirming === row.node.id;
              const waiting = pending.includes(row.node.id);
              return (
                <li
                  key={row.node.id}
                  className={`ip-row ip-backlog-row${waiting ? ' pending' : ''}`}
                  aria-busy={waiting || undefined}
                  data-node={row.node.id}
                  draggable={!asking && !waiting}
                  onDragStart={(e) => {
                    if (asking || waiting) return e.preventDefault();
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(row.node.id));
                    onDragStart(row.node.id);
                  }}
                  onDragEnd={onDragEnd}
                  onClick={asking || waiting ? undefined : rowClick('backlog', () => onOpenNode(row.node.id))}
                  // A press on the confirming row outside its buttons puts focus in the confirm (or keeps it there), so Escape
                  // still closes it.
                  onMouseDown={asking ? (e) => {
                    if ((e.target as HTMLElement).closest('button')) return;
                    e.preventDefault();
                    const confirm = e.currentTarget.querySelector<HTMLElement>('.ip-confirm');
                    if (confirm && !confirm.contains(document.activeElement)) confirm.focus();
                  } : undefined}
                >
                  {asking ? (
                    <div
                      className="ip-confirm"
                      role="dialog"
                      aria-modal={false}
                      aria-labelledby={`bl${row.node.id}q`}
                      aria-describedby={`bl${row.node.id}d`}
                      tabIndex={-1}
                      data-act
                      onKeyDown={(e) => {
                        if (e.key !== 'Escape') return;
                        e.stopPropagation();
                        cancel(row.node.id);
                      }}
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
                  ) : (
                    <div className="ip-line">
                      <button type="button" className="ip-row-title">{row.node.title}</button>
                      <LabelChip label={row.node.label} />
                      <StepMarks row={row} now={now} onOpenResource={onOpenResource} />
                      <button type="button" className="ip-hover-act" data-act onClick={(e) => {
                        noteAction('backlog', 'to_next');
                        focusTargetAfter(e.currentTarget.closest('li'))?.focus();
                        onToNext(row.node.id);
                      }}>to Next</button>
                      {!hasKids(row.node.id) && (
                        <button type="button" className="ip-hover-act" data-act data-delete aria-haspopup="dialog" onClick={() => setConfirming(row.node.id)}>Delete…</button>
                      )}
                    </div>
                  )}
                  {ended && <div className="ip-system-line">{ended}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
