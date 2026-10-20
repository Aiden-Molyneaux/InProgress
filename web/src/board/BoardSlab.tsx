import { useMemo, useState } from 'react';
import { sessionActivity } from '../../../src/core/activity';
import { sessionDisplayTitle } from '../../../src/core/types';
import { leadTitle, WORDS } from '../live';
import { noteAction } from '../measure';
import { Markdown } from '../panels/Markdown';
import { CommsSlab } from '../page/CommsSlab';
import { Button } from '../parts/Button';
import { Chip } from '../parts/Chip';
import { Eyebrow } from '../parts/Eyebrow';
import type { BandProps } from './bandProps';
import { headerSessions } from './headerSessions';
import { MenuButton } from './MenuButton';
import { NoteText } from './NoteText';
import { OpenScope, OpenButton, OpenFailure } from './TaskBox';
import { ageShort, firstSentence, hygieneTitle, noteHasMore } from './text';

/** The "N to tidy" button and the popover of the marked steps under it. */
function Tidy({ board, onOpenNode }: Pick<BandProps, 'board' | 'onOpenNode'>) {
  return (
    <MenuButton
      variant="danger"
      title={hygieneTitle(board)}
      menuLabel="Steps to tidy"
      items={board.marked.map((row) => ({
        key: row.node.id,
        label: `#${row.node.id} ${row.marks.join(' ')}`,
        onSelect: () => {
          noteAction('header', 'tidy_open');
          onOpenNode(row.node.id);
        },
      }))}
    >
      {`${board.marked.length} to tidy`}
    </MenuButton>
  );
}

/** The Board's slab: the state note's first sentence (the whole note on More), the steps to tidy, and the sessions on no step. */
export function BoardSlab({ snapshot, board, now, onOpenNode }: BandProps) {
  const note = snapshot.stateNote;
  const [more, setMore] = useState(false);
  const has = useMemo(() => {
    const ids = new Set(snapshot.nodes.map((n) => n.id));
    return (id: number) => ids.has(id);
  }, [snapshot.nodes]);
  const idle = headerSessions(board, snapshot.sessions, now);
  const actions = (
    <>
      {note && noteHasMore(note.content) && (
        <Button variant="ghost" size="sm" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          {more ? 'Less' : 'More'}
        </Button>
      )}
      {board.marked.length > 0 && <Tidy board={board} onOpenNode={onOpenNode} />}
    </>
  );
  const below =
    idle.length > 0 ? (
      <div className="ip-noclaim" role="group" aria-label="No claimed step">
        <Eyebrow glyph="//" glyphTone="dim">NO CLAIMED STEP</Eyebrow>
        <OpenScope area="header">
          {idle.map((s) => (
            <div key={s.id} className="ip-noclaim-item">
              <div className="ip-noclaim-line" title={leadTitle(s, now)}>
                <span className="ip-noclaim-dot" aria-hidden="true">◆</span>
                <span className="ip-noclaim-title">{sessionDisplayTitle(s)}</span>
                {s.role === 'orchestrator' && <Chip tone="quiet">ORCHESTRATOR</Chip>}
                <span className="ip-noclaim-word">{WORDS[sessionActivity(s, now)]}</span>
                <OpenButton sessionId={s.id} className="ip-noclaim-open" variant="ghost" glyph="↗" label="Open session">Open</OpenButton>
              </div>
              <OpenFailure sessionId={s.id} />
            </div>
          ))}
        </OpenScope>
      </div>
    ) : undefined;
  return (
    <CommsSlab age={note ? ageShort(note.updatedAt, now) : null} actions={actions} below={below}>
      {!note ? (
        <p className="ip-quiet">No state note yet</p>
      ) : more ? (
        <Markdown text={note.content} stepRefs={{ has, open: onOpenNode }} />
      ) : (
        <p className="ip-note-first">
          <NoteText text={firstSentence(note.content)} has={has} onOpen={onOpenNode} />
        </p>
      )}
    </CommsSlab>
  );
}
