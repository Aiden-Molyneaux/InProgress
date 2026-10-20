import { useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { sessionActivity } from '../../../src/core/activity';
import { sessionDisplayTitle } from '../../../src/core/types';
import { leadTitle, WORDS } from '../live';
import { noteAction } from '../measure';
import { Markdown } from '../panels/Markdown';
import { CommsSlab } from '../page/CommsSlab';
import { Button } from '../parts/Button';
import { Chip } from '../parts/Chip';
import { Eyebrow } from '../parts/Eyebrow';
import { Menu, MenuItem } from '../parts/Menu';
import { usePressOutside } from '../parts/usePressOutside';
import type { BandProps } from './bandProps';
import { headerSessions } from './headerSessions';
import { NoteText } from './NoteText';
import { OpenScope, OpenButton, OpenFailure } from './TaskBox';
import { ageShort, firstSentence, hygieneTitle, noteHasMore } from './text';

/** The "N to tidy" button and the popover of the marked steps under it. */
function Tidy({ board, onOpenNode }: Pick<BandProps, 'board' | 'onOpenNode'>) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const shut = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) opener.current?.focus();
  };
  // A press elsewhere closes it and leaves focus where the press put it.
  usePressOutside(open, [surface, opener], () => setOpen(false));
  // Tab and Shift+Tab leave the menu, and it closes behind them.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && !e.currentTarget.contains(to) && to !== opener.current) setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Menu items are out of the Tab order, so Shift+Tab from one would land on the button with the menu still open.
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      shut(true);
    }
  };
  return (
    <span className="ip-tidy-wrap">
      <Button
        ref={opener}
        variant="danger"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        title={hygieneTitle(board)}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          // Escape on the button closes the menu and stops there: it must not also close Details.
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            shut(true);
          }
        }}
      >
        {`${board.marked.length} to tidy`}
      </Button>
      {open && (
        <div ref={surface} className="ip-tidy-pop" onKeyDown={onKeyDown} onBlur={onBlur}>
          <Menu label="Steps to tidy" autoFocus onClose={() => shut(true)}>
            {board.marked.map((row) => (
              <MenuItem
                key={row.node.id}
                onSelect={() => {
                  // Focus goes to the button first: Details records the focused element as its opener, and Escape returns there.
                  shut(true);
                  noteAction('header', 'tidy_open');
                  onOpenNode(row.node.id);
                }}
              >
                {`#${row.node.id} ${row.marks.join(' ')}`}
              </MenuItem>
            ))}
          </Menu>
        </div>
      )}
    </span>
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
