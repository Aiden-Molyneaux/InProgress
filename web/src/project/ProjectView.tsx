import { useState } from 'react';
import { deriveBoard } from '../../../src/core/board';
import { Character } from '../Character';
import { useWide } from '../board/useWide';
import { ageShort } from '../board/text';
import { Markdown } from '../panels/Markdown';
import type { ViewProps } from '../views/props';
import { loadFolds, saveFolds } from './projectFolds';
import { projectSections } from './projectOutline';
import { Section } from './Section';

const DONE_GROUPS_KEY = 'done:0';

/** The key to the left rail, wide only. */
function RailKey() {
  return (
    <div className="ip-railkey" role="group" aria-label="The rail">
      <div className="ip-label">The rail</div>
      <div><span className="ip-dot live" aria-hidden="true" /> now, a session is on it</div>
      <div><span className="ip-dot idle" aria-hidden="true" /> now, no session</div>
      <div><span className="ip-num" aria-hidden="true">①</span> next, in queue order</div>
      <div><span className="ip-num ip-letter" aria-hidden="true">C</span> next, in a session's own queue</div>
      <div><span className="ip-dot ring" aria-hidden="true" /> backlog</div>
    </div>
  );
}

/** The Project view (spec 2.4 and 2.8): the state note, then one section per top-level group as an outline with a position rail. */
export function ProjectView({ snapshot, now, onOpenNode, onOpenResource, onStatus }: ViewProps) {
  const wide = useWide();
  const projectId = snapshot.project.id;
  const [folds, setFolds] = useState(() => loadFolds(projectId));
  const board = deriveBoard(snapshot, now);
  const sections = projectSections(snapshot, board);
  const flip = (key: string, current: boolean) => {
    const next = { ...folds, [key]: !current };
    setFolds(next);
    saveFolds(projectId, next);
  };
  const key = (s: { group: { id: number } | null }) => `section:${s.group?.id ?? 0}`;
  const doneGroups = sections.filter((s) => s.allDone);
  const doneGroupsOpen = folds[DONE_GROUPS_KEY] ?? false;
  // A fully done group shows as a section only once it is picked from "Done groups".
  const shown = sections.filter((s) => !s.allDone || folds[key(s)] === true);
  const note = snapshot.stateNote;
  const orchestrator = snapshot.sessions.find((s) => s.role === 'orchestrator' && s.state !== 'ended');
  const outline = { snapshot, board, now, wide, doneOpen: (parentId: number) => folds[`done:${parentId}`] ?? false, onToggleDone: (parentId: number) => flip(`done:${parentId}`, folds[`done:${parentId}`] ?? false), onOpenNode, onOpenResource };

  const noteBlock = note ? (
    <div className="ip-msg ip-pnote">
      <Character size={24} state="idle" slot={orchestrator?.slot ?? null} seed={`orchestrator:${projectId}`} />
      <div className="ip-msg-body">
        <div className="ip-msg-head">
          <b>Orchestrator</b> · <span className="ip-time">{ageShort(note.updatedAt, now)}</span>
        </div>
        <Markdown text={note.content} />
      </div>
    </div>
  ) : (
    <p className="ip-quiet">No state note yet</p>
  );

  const doneBlock = doneGroups.length > 0 && (
    <div className="ip-donegroups">
      <button type="button" className="ip-fold" aria-expanded={doneGroupsOpen} onClick={() => flip(DONE_GROUPS_KEY, doneGroupsOpen)}>
        {`Done groups · ${doneGroups.length} ${doneGroupsOpen ? '▾' : '▸'}`}
      </button>
      {doneGroupsOpen && (
        <ul>
          {doneGroups.map((s) => (
            <li key={key(s)}>
              <button type="button" className="ip-dg-item" aria-expanded={folds[key(s)] === true} onClick={() => flip(key(s), folds[key(s)] === true)}>
                <span className="ip-id">{`#${s.group!.id}`}</span> {s.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const sectionList = (
    <div className="ip-sections" role="region" aria-label="Sections">
      {shown.length === 0 && <p className="ip-quiet ip-empty-line">No steps yet</p>}
      {shown.map((s) => {
        const open = folds[key(s)] ?? s.startsOpen;
        return (
          <Section key={key(s)} section={s} open={open} onToggle={() => flip(key(s), open)} onStatus={onStatus} {...outline} />
        );
      })}
    </div>
  );

  return (
    <div className={`ip-project ${wide ? 'wide' : 'narrow'}`}>
      {wide ? (
        <>
          <div className="ip-pside">
            <h2 className="ip-view-name">{snapshot.project.name}</h2>
            {noteBlock}
            <RailKey />
            {doneBlock}
          </div>
          <div className="ip-pmain">{sectionList}</div>
        </>
      ) : (
        <>
          <h2 className="ip-view-name">{snapshot.project.name}</h2>
          {noteBlock}
          {sectionList}
          {doneBlock}
        </>
      )}
    </div>
  );
}
