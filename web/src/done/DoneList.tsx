import { useMemo, useRef, useState } from 'react';
import { useKeepRowFocus } from '../backlog/useKeepRowFocus';
import { deriveBoard, type BoardRow } from '../../../src/core/board';
import { LABEL_GLYPHS } from '../../../src/core/types';
import { rowClick } from '../board/Marks';
import { noteAction } from '../measure';
import { PageHead } from '../page/PageHead';
import { projectCode } from '../page/projectCode';
import { Chip } from '../parts/Chip';
import { EmptyState } from '../parts/EmptyState';
import { Eyebrow } from '../parts/Eyebrow';
import { useListCursor } from '../parts/ListCursor';
import { TabStrip } from '../parts/TabStrip';
import { load, save } from '../storage';
import type { ViewProps } from '../views/props';
import { byPhase, byTime, clock, shortDate } from './doneGroups';

type Order = 'time' | 'phase';
const KEY = 'ip.doneOrder';

/**
 * Every done step of the project (#406), a view of its own: the rail opens it, and so does "All done ›" on the Board. A page
 * like the Backlog's, read as a log: by time (a section per day) or by phase (a section per parent step). Every row is one
 * list: one Tab stop, Up and Down through them, Enter (or a click) opens Details as the Done column's rows do.
 */
export function DoneList({ snapshot, now, onOpenNode, codes }: ViewProps & { codes?: Map<number, string> }) {
  const { project } = snapshot;
  const [order, setOrder] = useState<Order>(() => (load(KEY) === 'phase' ? 'phase' : 'time'));
  const pick = (o: Order) => {
    setOrder(o);
    save(KEY, o);
  };
  const heading = useRef<HTMLHeadingElement>(null);
  const done = useMemo(() => deriveBoard(snapshot, now).done, [snapshot, now]);
  const root = useMemo(() => snapshot.nodes.find((n) => n.parentId === null) ?? null, [snapshot]);
  const sections = useMemo(
    () =>
      order === 'time'
        ? byTime(done, now).map((g) => ({ key: g.heading, eyebrow: `${g.heading.toUpperCase()} · ${g.rows.length}`, path: null as string | null, rows: g.rows }))
        : byPhase(done, root).map((g) => ({ key: String(g.parent?.id ?? 'top'), eyebrow: `${g.rows.length} DONE`, path: g.path as string | null, rows: g.rows })),
    [done, now, order, root],
  );

  // Every drawn row, section after section, is one list.
  const rowIds = sections.flatMap((s) => s.rows.map((r) => r.node.id));
  const rowAt = new Map(rowIds.map((id, i) => [id, i]));
  const { itemProps } = useListCursor(
    [rowIds.length],
    (at) => {
      const id = rowIds[at.row];
      if (id === undefined) return;
      noteAction('done_list', 'open');
      onOpenNode(id);
    },
    [rowIds.map(String)],
  );

  // A row that leaves through a write from elsewhere hands its focus to a neighbour (or the page title).
  const list = useRef<HTMLDivElement>(null);
  useKeepRowFocus(list, rowIds, heading);

  const parentTitle = (row: BoardRow) => (row.crumb.length > 0 ? row.crumb[row.crumb.length - 1].title : null);
  const item = (row: BoardRow) => {
    const { node } = row;
    const { onKeyDown, ...cursor } = itemProps(0, rowAt.get(node.id)!);
    const when = node.completedAt ? (order === 'time' ? clock(node.completedAt) : shortDate(node.completedAt, now)) : '';
    const parent = order === 'time' ? parentTitle(row) : null;
    const outcome = node.outcome.trim();
    return (
      <li key={node.id} {...cursor} onKeyDown={onKeyDown} className="ip-done-row" data-node={node.id} onClick={rowClick('done_list', () => onOpenNode(node.id))}>
        <span className="ip-done-when">{when}</span>
        <div className="ip-done-body">
          <div className="ip-done-line">
            <span className="ip-done-id">#{node.id}</span>
            <span className="ip-row-title ip-done-title" title={node.title}>{node.title}</span>
            {node.label && <Chip tone="label" glyph={LABEL_GLYPHS[node.label]}>{node.label}</Chip>}
            {parent && <span className="ip-done-parent" title={parent}>{parent}</span>}
          </div>
          {outcome && <p className="ip-done-outcome" title={outcome}>{outcome}</p>}
        </div>
      </li>
    );
  };

  return (
    <div className="ip-donelist" ref={list}>
      <div className="ip-page">
        <PageHead
          code={codes?.get(project.id) ?? projectCode(project.name)}
          name="ALL DONE"
          meta={[{ value: done.length, label: 'DONE' }]}
          decodeKey={project.id}
          titleRef={heading}
        >
          <TabStrip
            variant="segmented"
            label="Order"
            items={[{ id: 'time', label: 'Time' }, { id: 'phase', label: 'Phase' }]}
            value={order}
            onChange={(id) => pick(id === 'phase' ? 'phase' : 'time')}
          />
        </PageHead>
        {done.length === 0 ? (
          <EmptyState>Nothing done yet</EmptyState>
        ) : (
          sections.map((s) => (
            <section key={s.key} className="ip-done-sec" aria-label={s.path ?? s.eyebrow}>
              <header className="ip-done-head">
                {s.path === null ? (
                  <Eyebrow as="h3">{s.eyebrow}</Eyebrow>
                ) : (
                  <>
                    <Eyebrow>{s.eyebrow}</Eyebrow>
                    <h3 className="ip-done-path">{s.path}</h3>
                  </>
                )}
              </header>
              <ul className="ip-done-list">{s.rows.map(item)}</ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
