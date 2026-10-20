import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { Board, BoardRow } from '../../../src/core/board';
import { sessionDisplayTitle, type ProjectSnapshot, type TreeNode } from '../../../src/core/types';
import { LabelChip, rowClick, StepMarks } from '../board/Marks';
import { QuickAdd } from '../board/QuickAdd';
import { ageShort } from '../board/text';
import { Button } from '../parts/Button';
import { Eyebrow } from '../parts/Eyebrow';
import type { CursorItemProps } from '../parts/ListCursor';
import { Readout } from '../parts/Readout';
import type { ViewProps } from '../views/props';
import { DocsMenu } from './DocsMenu';
import { RowMark } from './PositionMark';
import { renderedRows, type OutlineLine, type Section as SectionData } from './projectOutline';

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
  const legend = legendText(counts) || 'no steps yet';
  return (
    <div className="ip-sbar" role="img" aria-label={legend} title={legend}>
      {parts.map(([name, n]) => (
        <i key={name} className={`seg-${name}`} style={{ flex: n }} />
      ))}
    </div>
  );
}

export interface OutlineProps extends Pick<ViewProps, 'now' | 'onOpenNode' | 'onOpenResource'> {
  snapshot: ProjectSnapshot;
  board: Board;
  wide: boolean;
  /** Whether a parent's done children are open. */
  doneOpen: (parentId: number) => boolean;
  onToggleDone: (parentId: number) => void;
  /** The list cursor's props for the row with this key (`s<id>`, `d<parentId>`, `o<id>`). */
  cursorFor: (key: string) => CursorItemProps | undefined;
}

type RowContext = Pick<OutlineProps, 'snapshot' | 'now' | 'wide' | 'onOpenNode' | 'onOpenResource'>;

/** A row's indent for its depth, as a custom property the sheet reads. */
const indent = (depth: number, wide: boolean) => ({ '--indent': `${depth * (wide ? 16 : 12)}px` }) as CSSProperties;

function StepRow({ node, row, depth, cursor, snapshot, now, wide, onOpenNode, onOpenResource }: RowContext & { node: TreeNode; row: BoardRow | null; depth: number; cursor?: CursorItemProps }) {
  const docs = snapshot.resources.filter((r) => r.nodeId === node.id).length;
  const onIt = row ? [...row.sessions, ...(row.owner ? [row.owner] : [])] : [];
  const marks = row ? <StepMarks row={row} now={now} onOpenResource={onOpenResource} area="project" /> : null;
  const sessions = (
    <span className="ip-osess">
      {onIt.map((s) => (
        <span key={s.id} className="ip-osess-title" title={sessionDisplayTitle(s)}>{sessionDisplayTitle(s)}</span>
      ))}
    </span>
  );
  return (
    <li
      className={`ip-orow${row?.column === 'done' ? ' is-done' : ''}`}
      data-node={node.id}
      style={indent(depth, wide)}
      onClick={rowClick('project', () => onOpenNode(node.id))}
      {...cursor}
    >
      <span className="ip-orail"><RowMark node={node} row={row} /></span>
      <div className="ip-ostep">
        <span className="ip-id">{`#${node.id}`}</span>{' '}
        <button type="button" className={`ip-row-title${row || node.status === 'parked' ? '' : ' grp'}`}>{node.title}</button>
      </div>
      {wide ? (
        <>
          <span className="ip-ocell"><LabelChip label={node.label} /></span>
          <span className="ip-ocell">{marks}</span>
          {sessions}
          <span className="ip-ocell right">{docs > 0 && <span className="ip-docs" title={`${docs} resource${docs > 1 ? 's' : ''}`}>{`▤ ${docs}`}</span>}</span>
        </>
      ) : (
        <span className="ip-ominor">
          <LabelChip label={node.label} />
          {marks}
          {sessions}
        </span>
      )}
    </li>
  );
}

function Lines({ lines, ...p }: OutlineProps & { lines: OutlineLine[] }): ReactNode {
  return renderedRows(lines, p.doneOpen).map((r) => {
    if (r.kind !== 'fold') {
      return <StepRow key={r.key} node={r.node} row={p.board.byId.get(r.node.id) ?? null} depth={r.depth} cursor={p.cursorFor(r.key)} snapshot={p.snapshot} now={p.now} wide={p.wide} onOpenNode={p.onOpenNode} onOpenResource={p.onOpenResource} />;
    }
    const line = r.fold!;
    const open = p.doneOpen(line.parentId);
    const latest = `✓ ${line.count} done · latest #${line.latest.id} ${line.latest.title}${line.latest.completedAt ? ` · ${ageShort(line.latest.completedAt, p.now).toUpperCase()}` : ''}`;
    return (
      <li key={r.key} className="ip-orow ip-odone-row" style={indent(line.depth, p.wide)} {...p.cursorFor(r.key)}>
        <span className="ip-orail" />
        <div className="ip-ostep">
          <button type="button" className="ip-done-fold-btn" data-act aria-expanded={open} onClick={() => p.onToggleDone(line.parentId)}>
            {latest}
          </button>
        </div>
      </li>
    );
  });
}

/** One section: a head with its fold toggle, readout and docs menu, the bar, its outline when open, and "+ Add a step" at its foot (spec 2.4). */
export function Section({
  section, open, onToggle, elementRef, snapshot, board, now, wide, doneOpen, onToggleDone, cursorFor, onOpenNode, onOpenResource, onStatus,
}: OutlineProps & Pick<ViewProps, 'onStatus'> & { section: SectionData; open: boolean; onToggle: () => void; elementRef: (element: HTMLElement | null) => void }) {
  const { group, title, done, total, counts, docs, lines } = section;
  const [adding, setAdding] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (adding) field.current?.focus();
  }, [adding]);
  const p: OutlineProps = { snapshot, board, now, wide, doneOpen, onToggleDone, cursorFor, onOpenNode, onOpenResource };
  // A click on the head toggles, unless it landed on a control of the head's own.
  const headClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('button, .p-menubtn')) onToggle();
  };
  return (
    <section ref={elementRef} className={`ip-section${open ? ' open' : ''}`} aria-label={title}>
      <div className="ip-sec-head" onClick={headClick}>
        <button type="button" className="ip-sec-toggle" aria-expanded={open} aria-label={title} onClick={onToggle}>
          <Eyebrow glyph="[+]">{group ? `#${group.id}` : null}</Eyebrow>
          <span className="ip-sec-title">{title}</span>
        </button>
        <Readout label="DONE" value={`${done}/${total}`} title="done of all steps below" />
        {docs.length > 0 && <DocsMenu docs={docs} label={title} onOpenResource={onOpenResource} />}
        <span className="ip-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </div>
      <SegmentedBar counts={counts} />
      {open && (
        <div className="ip-outline">
          <ul>
            <Lines lines={lines} {...p} />
          </ul>
          <div className="ip-sec-foot">
            <Button ref={addButton} variant="ghost" size="sm" onClick={() => (adding ? field.current?.focus() : setAdding(true))}>
              + Add a step
            </Button>
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
