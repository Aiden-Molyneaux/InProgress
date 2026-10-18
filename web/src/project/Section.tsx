import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Board, BoardRow } from '../../../src/core/board';
import { sessionDisplayTitle, type ProjectSnapshot, type TreeNode } from '../../../src/core/types';
import { LabelChip, rowClick, StepMarks } from '../board/Marks';
import { Marker } from '../Marker';
import { numeral } from '../board/NextColumn';
import { QuickAdd } from '../board/QuickAdd';
import { ageShort } from '../board/text';
import type { ViewProps } from '../views/props';
import { DocsMenu } from './DocsMenu';
import type { OutlineLine, Section as SectionData } from './projectOutline';

/** "22 done · 2 now · 2 next · 2 backlog", with the zero counts left out. */
export function legendText(c: SectionData['counts']): string {
  return ([[c.done, 'done'], [c.now, 'now'], [c.next, 'next'], [c.backlog, 'backlog']] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ');
}

/** The segmented bar: done, now, next, backlog, each as wide as its count. */
function SegmentedBar({ counts }: { counts: SectionData['counts'] }) {
  const parts = ([['done', counts.done], ['now', counts.now], ['next', counts.next], ['backlog', counts.backlog]] as const).filter(([, n]) => n > 0);
  return (
    <div className="ip-sbar" role="img" aria-label={legendText(counts) || 'no steps yet'}>
      {parts.map(([name, n]) => (
        <i key={name} className={`seg-${name}`} style={{ flex: n }} />
      ))}
    </div>
  );
}

/** The left rail's mark for a step: dot, number, ◆ or ring (spec 2.8). */
function RailMark({ row }: { row: BoardRow | null }) {
  if (!row) return null;
  switch (row.column) {
    case 'now':
      return row.sessions.length > 0 ? <span className="ip-dot live" role="img" aria-label="now, a session is on it" /> : <span className="ip-dot idle" role="img" aria-label="now, no session" />;
    case 'next': {
      const owner = row.owner;
      return owner ? (
        <span className="ip-num ip-own" role="img" aria-label={`next, in the own queue of "${sessionDisplayTitle(owner)}"`} title={sessionDisplayTitle(owner)}>
          ◆
        </span>
      ) : (
        <span className="ip-num" role="img" aria-label={`next, number ${row.queueNumber ?? 0}`}>{numeral(row.queueNumber ?? 0)}</span>
      );
    }
    case 'backlog':
      return <span className="ip-dot ring" role="img" aria-label="backlog" />;
    default:
      return <span className="ip-rail-done" role="img" aria-label="done">✓</span>;
  }
}

export interface OutlineProps extends Pick<ViewProps, 'now' | 'onOpenNode' | 'onOpenResource'> {
  snapshot: ProjectSnapshot;
  board: Board;
  wide: boolean;
  /** Whether a parent's done children are open. */
  doneOpen: (parentId: number) => boolean;
  onToggleDone: (parentId: number) => void;
}

function StepRow({ node, row, depth, snapshot, now, wide, onOpenNode, onOpenResource }: Pick<OutlineProps, 'snapshot' | 'now' | 'wide' | 'onOpenNode' | 'onOpenResource'> & { node: TreeNode; row: BoardRow | null; depth: number }) {
  const docs = snapshot.resources.filter((r) => r.nodeId === node.id).length;
  const onIt = row ? [...row.sessions, ...(row.owner ? [row.owner] : [])] : [];
  const marks = row ? <StepMarks row={row} now={now} onOpenResource={onOpenResource} area="project" /> : null;
  return (
    <li className={`ip-orow${wide ? ' wide' : ''}${row?.column === 'done' ? ' is-done' : ''}`} data-node={node.id} onClick={rowClick('project', () => onOpenNode(node.id))}>
      <span className="ip-orail">
        {node.status === 'parked' ? <Marker status="parked" question={false} paused={false} needsYou={false} pulse={false} title="Parked" /> : <RailMark row={row} />}
      </span>
      <div className="ip-ostep" style={{ paddingLeft: depth * (wide ? 16 : 10) }}>
        <span className="ip-id">{`#${node.id}`}</span>{' '}
        <button type="button" className={`ip-row-title${row ? '' : ' grp'}`}>{node.title}</button>
        {!wide && (
          <span className="ip-ominor">
            <LabelChip label={node.label} />
            {marks}
          </span>
        )}
      </div>
      {wide && (
        <>
          <span className="ip-ocell"><LabelChip label={node.label} /></span>
          <span className="ip-ocell">{marks}</span>
        </>
      )}
      <span className="ip-osess">
        {onIt.map((s) => (
          <span key={s.id} className="ip-osess-title" title={sessionDisplayTitle(s)}>{sessionDisplayTitle(s)}</span>
        ))}
      </span>
      {wide && <span className="ip-ocell right">{docs > 0 && <span className="ip-docs" title={`${docs} resource${docs > 1 ? 's' : ''}`}>{`▤ ${docs}`}</span>}</span>}
    </li>
  );
}

function Lines({ lines, ...p }: OutlineProps & { lines: OutlineLine[] }): ReactNode {
  return lines.flatMap((line) => {
    if (line.kind === 'step') return <StepRow key={`s${line.node.id}`} node={line.node} row={line.row} depth={line.depth} snapshot={p.snapshot} now={p.now} wide={p.wide} onOpenNode={p.onOpenNode} onOpenResource={p.onOpenResource} />;
    const open = p.doneOpen(line.parentId);
    // A parent's done children, once its fold is open, follow the fold line.
    const opened = open ? line.nodes.map((n) => <StepRow key={`o${n.id}`} node={n} row={p.board.byId.get(n.id) ?? null} depth={line.depth} snapshot={p.snapshot} now={p.now} wide={p.wide} onOpenNode={p.onOpenNode} onOpenResource={p.onOpenResource} />) : [];
    return [
      <li key={`d${line.parentId}`} className="ip-orow ip-odone-row">
        <span className="ip-orail" />
        <div className="ip-ostep" style={{ paddingLeft: line.depth * (p.wide ? 16 : 10) }}>
          <button type="button" className="ip-done-fold-btn" data-act aria-expanded={open} onClick={() => p.onToggleDone(line.parentId)}>
            {`✓ ${line.count} done · latest: #${line.latest.id} ${line.latest.title}${line.latest.completedAt ? ` ${ageShort(line.latest.completedAt, p.now)}` : ''}`}
          </button>
        </div>
      </li>,
      ...opened,
    ];
  });
}

/** One section: a fold button with the bar, its outline when open, and "+ Add a step" at its foot (spec 2.4). */
export function Section({ section, open, onToggle, snapshot, board, now, wide, doneOpen, onToggleDone, onOpenNode, onOpenResource, onStatus }: OutlineProps & Pick<ViewProps, 'onStatus'> & { section: SectionData; open: boolean; onToggle: () => void }) {
  const { group, title, done, total, counts, docs, lines } = section;
  const [adding, setAdding] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (adding) field.current?.focus();
  }, [adding]);
  const p: OutlineProps = { snapshot, board, now, wide, doneOpen, onToggleDone, onOpenNode, onOpenResource };
  return (
    <section className={`ip-section${open ? ' open' : ''}`} aria-label={title}>
      <div className="ip-sec-head">
        <button type="button" className="ip-sec-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="ip-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          {group && <span className="ip-id">{`#${group.id}`}</span>}
          <span className="ip-sec-title">{title}</span>
        </button>
        <span className="ip-legend">{legendText(counts)}</span>
        <span className="ip-frac" title="done of all steps below">{`${done}/${total}`}</span>
        {docs.length > 0 && <DocsMenu docs={docs} label={title} onOpenResource={onOpenResource} />}
      </div>
      <SegmentedBar counts={counts} />
      {open && (
        <div className="ip-outline">
          {wide && lines.length > 0 && (
            <div className="ip-orow ip-ohead" aria-hidden="true">
              <span />
              <span>Step</span>
              <span>Label</span>
              <span>Marks</span>
              <span>Sessions</span>
              <span className="right">Docs</span>
            </div>
          )}
          <ul>
            <Lines lines={lines} {...p} />
          </ul>
          <div className="ip-sec-foot">
            <button ref={addButton} type="button" className="ip-add-step" onClick={() => (adding ? field.current?.focus() : setAdding(true))}>
              + Add a step
            </button>
            {adding && (
              <QuickAdd
                projectId={snapshot.project.id}
                slug={snapshot.project.slug}
                parent={group?.id ?? null}
                label={`Add a step to ${title}`}
                inputRef={field}
                onStatus={onStatus}
                onClose={() => {
                  setAdding(false);
                  addButton.current?.focus();
                }}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
