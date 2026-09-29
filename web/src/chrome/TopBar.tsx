import { useEffect, useRef, useState } from 'react';
import type { Project, ProjectSummary } from '../../../src/core/types';

interface TopBarProps {
  projects: ProjectSummary[];
  current: Project | null;
  onSelect: (slug: string) => void;
  needsYou: number;
  onNeedsYou: () => void;
  follow: boolean;
  onFollow: () => void;
}

function ProjectRow({ p, current, onPick }: { p: ProjectSummary; current: boolean; onPick: (slug: string) => void }) {
  const dot = p.workingSessions > 0 ? 'clay' : p.needsYou > 0 ? 'amber' : 'grey';
  const status = [p.workingSessions > 0 ? `◆ ${p.workingSessions} working` : p.activeSessions > 0 ? 'idle' : null, p.needsYou > 0 ? `${p.needsYou} need you` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <button role="option" aria-selected={current} className={`ip-mi${current ? ' cur' : ''}`} onClick={() => onPick(p.slug)}>
      <span className={`ip-dot ${dot}`} />
      <span className="nm">{p.name}</span>
      <span className="st">{status || 'no sessions'}</span>
    </button>
  );
}

export function TopBar({ projects, current, onSelect, needsYou, onNeedsYou, follow, onFollow }: TopBarProps) {
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const active = projects.filter((p) => p.status === 'active');
  const archived = projects.filter((p) => p.status === 'archived');
  const othersWorking = projects.some((p) => p.id !== current?.id && p.workingSessions > 0);
  const pick = (slug: string) => {
    onSelect(slug);
    setOpen(false);
  };
  return (
    <header className="ip-topbar">
      <div className="ip-switcher" ref={ref}>
        <button className="ip-proj" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
          {open ? '▴' : '▾'} {current?.name ?? 'Projects'}
          {othersWorking && <span className="ip-dot clay" title="Another project has a working session" />}
        </button>
        {open && (
          <div className="ip-menu" role="listbox">
            {active.map((p) => (
              <ProjectRow key={p.id} p={p} current={p.id === current?.id} onPick={pick} />
            ))}
            {archived.length > 0 && (
              <>
                <div className="ip-sep" />
                <button className="ip-mi muted" onClick={() => setShowArchived((s) => !s)}>
                  Archived ({archived.length}) {showArchived ? '▾' : '▸'}
                </button>
                {showArchived && archived.map((p) => <ProjectRow key={p.id} p={p} current={p.id === current?.id} onPick={pick} />)}
              </>
            )}
          </div>
        )}
      </div>
      <span className="ip-spacer" />
      {needsYou > 0 && (
        <button className="ip-need" onClick={onNeedsYou} title="Jump to the next item waiting on you (N)">
          ● {needsYou} need you
        </button>
      )}
      <button className={`ip-follow${follow ? ' on' : ''}`} onClick={onFollow} aria-pressed={follow} title="Follow Claude's changes (F)">
        ⌖ Follow
      </button>
    </header>
  );
}
