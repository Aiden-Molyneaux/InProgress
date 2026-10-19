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
import { headMeta, projectSections } from './projectOutline';
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
  const setFold = (key: string, value: boolean) => {
    const next = { ...folds, [key]: value };
    setFolds(next);
    saveFolds(projectId, next);
  };
  const key = (s: { group: { id: number } | null }) => `section:${s.group?.id ?? 0}`;
  const doneGroups = sections.filter((s) => s.allDone);
  const finishedOpen = folds[FINISHED_KEY] ?? false;
  // A fully done group shows as a section only once it is picked from "Finished".
  const shown = sections.filter((s) => !s.allDone || folds[key(s)] === true);
  const isOpen = (s: (typeof sections)[number]) => folds[key(s)] ?? s.startsOpen;
  const note = snapshot.stateNote;

  // The section in view, and the jump from the index: open it if folded, scroll it to the top, put focus on its head.
  const elements = useRef(new Map<string, HTMLElement>());
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
    for (const [k, element] of elements.current) {
      if (current === null || element.getBoundingClientRect().top <= top + IN_VIEW_SLACK) current = k;
    }
    // Scrolled to the very end, the last section is the one in view though its top never reaches the page's top.
    if (page.scrollHeight > page.clientHeight && page.scrollTop + page.clientHeight >= page.scrollHeight - 1) current = [...elements.current.keys()].pop() ?? current;
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
    setFold(k, true);
  };
  useLayoutEffect(() => {
    if (pending.current === null) return;
    const k = pending.current;
    pending.current = null;
    scrollToSection(k);
  });
  // The elements map is in render order of the sections; measure after each render, and when the page is resized.
  useLayoutEffect(() => {
    measureInView();
  }, [measureInView, width, folds, snapshot]);

  // One list cursor across every open section's rows, in screen order.
  const cursorKeys: string[] = [];
  for (const s of shown) {
    if (!isOpen(s)) continue;
    for (const line of s.lines) {
      if (line.kind === 'step') cursorKeys.push(`s${line.node.id}`);
      else {
        cursorKeys.push(`d${line.parentId}`);
        if (folds[`done:${line.parentId}`] ?? false) for (const n of line.nodes) cursorKeys.push(`o${n.id}`);
      }
    }
  }
  const toggleDone = (parentId: number) => setFold(`done:${parentId}`, !(folds[`done:${parentId}`] ?? false));
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
    const row = cursorKeys.indexOf(k);
    return row < 0 ? undefined : itemProps(0, row);
  };

  const outline = { snapshot, board, now, wide, doneOpen: (parentId: number) => folds[`done:${parentId}`] ?? false, onToggleDone: toggleDone, cursorFor, onOpenNode, onOpenResource };

  const phases: PhaseEntry[] = shown.filter((s) => !s.allDone).map((s) => ({ key: key(s), title: s.title, done: s.done, now: s.counts.now, total: s.total }));
  const finished: FinishedEntry[] = doneGroups.map((s) => ({ key: key(s), id: s.group!.id, title: s.title }));
  const finishedBlock = (
    <FinishedPhases finished={finished} open={finishedOpen} current={inView} onToggle={() => setFold(FINISHED_KEY, !finishedOpen)} onJump={jumpTo} />
  );

  const slab = (
    <CommsSlab age={note ? ageShort(note.updatedAt, now).toUpperCase() : null}>
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
            onToggle={() => setFold(k, !open)}
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
    <div ref={root} className="ip-project" data-wide={wide || undefined} onScroll={measureInView} onWheel={release} onTouchMove={release} onKeyDown={release}>
      <div className="ip-page">
        <PageHead code={projectCode(snapshot.project.name)} name={snapshot.project.name} meta={headMeta(board, sections)} decodeKey={projectId} />
        {slab}
        {!wide && (
          <div className="ip-jump">
            <Eyebrow glyph="//">{`Phases · ${phases.length}`}</Eyebrow>
            <TabStrip
              variant="segmented"
              label="Phases"
              items={phases.map((p) => ({ id: p.key, label: p.title.length > 24 ? `${p.title.slice(0, 23)}…` : p.title }))}
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
              <PhaseIndex phases={phases} finished={finished} current={inView} finishedOpen={finishedOpen} onToggleFinished={() => setFold(FINISHED_KEY, !finishedOpen)} onJump={jumpTo} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
