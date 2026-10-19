import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { deriveBoard } from '../../../src/core/board';
import { ageShort } from '../board/text';
import { CommsSlab } from '../page/CommsSlab';
import { PageHead } from '../page/PageHead';
import { projectCode } from '../page/projectCode';
import { usePageWidth } from '../page/usePageWidth';
import { Markdown } from '../panels/Markdown';
import { Eyebrow } from '../parts/Eyebrow';
import { EmptyState } from '../parts/EmptyState';
import { useListCursor } from '../parts/ListCursor';
import { TabStrip } from '../parts/TabStrip';
import type { ViewProps } from '../views/props';
import { FINISHED_KEY, FinishedPhases, PhaseIndex, RailKey, type FinishedEntry, type PhaseEntry } from './PhaseIndex';
import { loadFolds, saveFolds } from './projectFolds';
import { headMeta, projectSections, renderedRows } from './projectOutline';
import { Section } from './Section';

/** A page this wide, in px, lays out with the phase index at the right. */
const WIDE_FROM = 1160;
/** A section is "in view" once its top is within this many px of the page's top. */
const IN_VIEW_SLACK = 24;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The Project view (spec 2.4 and 2.8): the page head, the state note, then one section per top-level group as an outline with a position rail. */
export function ProjectView({ snapshot, now, onOpenNode, onOpenResource, onStatus }: ViewProps) {
  const [root, width] = usePageWidth<HTMLDivElement>();
  const wide = width >= WIDE_FROM;
  const projectId = snapshot.project.id;
  const [folds, setFolds] = useState(() => loadFolds(projectId));
  const board = deriveBoard(snapshot, now);
  const sections = projectSections(snapshot, board);
  // `update` gets the fold's current value (undefined before a choice), so a toggle reads the latest state, not the render's.
  const setFold = (key: string, update: (was: boolean | undefined) => boolean) =>
    setFolds((prev) => {
      const next = { ...prev, [key]: update(prev[key]) };
      saveFolds(projectId, next);
      return next;
    });
  const key = (s: { group: { id: number } | null }) => `section:${s.group?.id ?? 0}`;
  const doneGroups = sections.filter((s) => s.allDone);
  const finishedOpen = folds[FINISHED_KEY] ?? false;
  // A fully done group shows as a section only once it is picked from "Finished".
  const shown = sections.filter((s) => !s.allDone || folds[key(s)] === true);
  const isOpen = (s: (typeof sections)[number]) => folds[key(s)] ?? s.startsOpen;
  const note = snapshot.stateNote;

  // The section in view, and the jump from the index: open it if folded, scroll it to the top, put focus on its head.
  const elements = useRef(new Map<string, HTMLElement>());
  // The shown sections' keys in screen order, for the measure.
  const order = useRef<string[]>([]);
  order.current = shown.map(key);
  const [inView, setInView] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  // A jump marks its section as the one in view, even when the page is too short to scroll it to the top, until the reader scrolls or types.
  const jumped = useRef<string | null>(null);
  const measureInView = useCallback(() => {
    const page = root.current;
    if (!page) return;
    if (jumped.current !== null && elements.current.has(jumped.current)) {
      setInView(jumped.current);
      return;
    }
    const top = page.getBoundingClientRect().top;
    let current: string | null = null;
    for (const k of order.current) {
      const element = elements.current.get(k);
      if (element && (current === null || element.getBoundingClientRect().top <= top + IN_VIEW_SLACK)) current = k;
    }
    // Scrolled to the very end, the last section is the one in view though its top never reaches the page's top.
    if (page.scrollHeight > page.clientHeight && page.scrollTop + page.clientHeight >= page.scrollHeight - 1) current = order.current.filter((k) => elements.current.has(k)).pop() ?? current;
    setInView((was) => (was === current ? was : current));
  }, [root]);
  const release = () => {
    jumped.current = null;
  };
  const scrollToSection = (k: string) => {
    const element = elements.current.get(k);
    if (!element) return;
    element.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    element.querySelector<HTMLElement>('.ip-sec-toggle')?.focus({ preventScroll: true });
    jumped.current = k;
    setInView(k);
  };
  const jumpTo = (k: string) => {
    const target = shown.find((s) => key(s) === k);
    if (target && isOpen(target)) {
      scrollToSection(k);
      return;
    }
    pending.current = k;
    setFold(k, () => true);
  };
  useLayoutEffect(() => {
    if (pending.current === null) return;
    const k = pending.current;
    pending.current = null;
    scrollToSection(k);
  });
  // Measure after each render, and when the page is resized.
  useLayoutEffect(() => {
    measureInView();
  }, [measureInView, width, folds, snapshot]);

  // One list cursor across every open section's rows, in screen order.
  const doneOpen = (parentId: number) => folds[`done:${parentId}`] ?? false;
  const cursorKeys = shown.flatMap((s) => (isOpen(s) ? renderedRows(s.lines, doneOpen).map((r) => r.key) : []));
  const cursorRow = new Map(cursorKeys.map((k, i) => [k, i]));
  const toggleDone = (parentId: number) => setFold(`done:${parentId}`, (was) => !was);
  const { itemProps } = useListCursor(
    [cursorKeys.length],
    ({ row }) => {
      const k = cursorKeys[row];
      if (!k) return;
      if (k.startsWith('d')) toggleDone(Number(k.slice(1)));
      else onOpenNode(Number(k.slice(1)));
    },
    [cursorKeys],
  );
  const cursorFor = (k: string) => {
    const row = cursorRow.get(k);
    return row === undefined ? undefined : itemProps(0, row);
  };

  const outline = { snapshot, board, now, wide, doneOpen, onToggleDone: toggleDone, cursorFor, onOpenNode, onOpenResource };

  const phases: PhaseEntry[] = shown.filter((s) => !s.allDone).map((s) => ({ key: key(s), title: s.title, done: s.done, now: s.counts.now, total: s.total }));
  const finished: FinishedEntry[] = doneGroups.map((s) => ({ key: key(s), id: s.group!.id, title: s.title }));
  const finishedBlock = (
    <FinishedPhases finished={finished} open={finishedOpen} current={inView} onToggle={() => setFold(FINISHED_KEY, (was) => !was)} onJump={jumpTo} />
  );

  const slab = (
    <CommsSlab age={note ? ageShort(note.updatedAt, now) : null}>
      {note ? <Markdown text={note.content} /> : <p className="ip-quiet">No state note yet</p>}
    </CommsSlab>
  );

  const sectionList = (
    <div className="ip-sections" role="region" aria-label="Sections">
      {shown.length === 0 && <EmptyState>No steps yet</EmptyState>}
      {shown.map((s) => {
        const k = key(s);
        const open = isOpen(s);
        return (
          <Section
            key={k}
            section={s}
            open={open}
            onToggle={() => setFold(k, (was) => !(was ?? s.startsOpen))}
            elementRef={(element) => {
              if (element) elements.current.set(k, element);
              else elements.current.delete(k);
            }}
            onStatus={onStatus}
            {...outline}
          />
        );
      })}
    </div>
  );

  return (
    <div ref={root} className="ip-project" data-wide={wide || undefined} onScroll={measureInView} onWheel={release} onTouchMove={release} onPointerDown={release} onKeyDown={release}>
      <div className="ip-page">
        <PageHead code={projectCode(snapshot.project.name)} name={snapshot.project.name} meta={headMeta(board, sections)} decodeKey={projectId} />
        {slab}
        {!wide && (
          <div className="ip-jump">
            <Eyebrow glyph="//">{`Phases · ${phases.length}`}</Eyebrow>
            <TabStrip
              variant="segmented"
              label="Phases"
              items={phases.map((p) => ({ id: p.key, label: [...p.title].length > 24 ? `${[...p.title].slice(0, 23).join('')}…` : p.title }))}
              value={inView ?? ''}
              onChange={jumpTo}
            />
          </div>
        )}
        <div className="ip-pbody">
          <div className="ip-pmain">
            <RailKey />
            {sectionList}
            {!wide && finishedBlock}
          </div>
          {wide && (
            <div className="ip-pside">
              <PhaseIndex phases={phases} finished={finished} current={inView} finishedOpen={finishedOpen} onToggleFinished={() => setFold(FINISHED_KEY, (was) => !was)} onJump={jumpTo} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
