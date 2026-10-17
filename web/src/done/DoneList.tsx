import { useMemo, useState } from 'react';
import { deriveBoard, type BoardRow } from '../../../src/core/board';
import { LabelChip, rowClick } from '../board/Marks';
import { load, save } from '../storage';
import type { ViewProps } from '../views/props';
import { byPhase, byTime, clock, shortDate } from './doneGroups';

type Order = 'time' | 'phase';
const KEY = 'ip.doneOrder';

/**
 * Every done step of the project (#406), opened from the foot of the Board's Done column. By time (a section per day) or
 * by phase (a section per parent step). Rows open Details as the Done column's do.
 */
export function DoneList({ snapshot, now, onOpenNode, onBack }: ViewProps & { onBack: () => void }) {
  const [order, setOrder] = useState<Order>(() => (load(KEY) === 'phase' ? 'phase' : 'time'));
  const pick = (o: Order) => {
    setOrder(o);
    save(KEY, o);
  };
  const done = useMemo(() => deriveBoard(snapshot, now).done, [snapshot, now]);

  const item = (row: BoardRow, left: string, suffix: string | null) => (
    <li key={row.node.id} className="ip-donelist-row" data-node={row.node.id} onClick={rowClick('done_list', () => onOpenNode(row.node.id))}>
      <span className="ip-donelist-when">{left}</span>
      <span className="ip-done-dot" aria-hidden="true">✓</span>
      <div className="ip-donelist-body">
        <div className="ip-quote">
          <span className="ip-sid">#{row.node.id}</span>
          <button type="button" className="ip-row-title">{row.node.title}</button>
          <LabelChip label={row.node.label} />
          {suffix && <span className="ip-quiet ip-donelist-parent">{suffix}</span>}
        </div>
        {row.node.outcome.trim() && <p className="ip-outcome-line ip-donelist-outcome">{row.node.outcome}</p>}
      </div>
    </li>
  );
  const parentTitle = (row: BoardRow) => (row.crumb.length > 0 ? row.crumb[row.crumb.length - 1].title : null);

  return (
    <div className="ip-donelist">
      <div className="ip-donelist-head">
        <button type="button" className="ip-donelist-back" onClick={onBack}>‹ Board</button>
        <span className="ip-quiet">{`${done.length} done`}</span>
        <div className="ip-donelist-toggle" role="group" aria-label="Order">
          <button type="button" aria-pressed={order === 'time'} onClick={() => pick('time')}>Time</button>
          <button type="button" aria-pressed={order === 'phase'} onClick={() => pick('phase')}>Phase</button>
        </div>
      </div>
      {done.length === 0 ? (
        <p className="ip-quiet ip-empty-line">Nothing done yet</p>
      ) : order === 'time' ? (
        byTime(done, now).map((g) => (
          <section key={g.heading} className="ip-donelist-group">
            <h3>{g.heading}</h3>
            <ol>{g.rows.map((r) => item(r, r.node.completedAt ? clock(r.node.completedAt) : '', parentTitle(r)))}</ol>
          </section>
        ))
      ) : (
        byPhase(done).map((g) => (
          <section key={g.parent?.id ?? 'top'} className="ip-donelist-group">
            <h3>{g.path}<span className="ip-quiet">{` · ${g.rows.length}`}</span></h3>
            <ol>{g.rows.map((r) => item(r, r.node.completedAt ? shortDate(r.node.completedAt, now) : '', null))}</ol>
          </section>
        ))
      )}
    </div>
  );
}
