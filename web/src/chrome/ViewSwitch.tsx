import type { View } from '../views/view';

const VIEWS: { view: View; label: string }[] = [
  { view: 'board', label: 'Board' },
  { view: 'project', label: 'Project' },
];

/** Board | Project: two buttons in the top bar, the current one pressed. */
export function ViewSwitch({ view, onPick }: { view: View; onPick: (v: View) => void }) {
  return (
    <div className="ip-viewswitch" role="group" aria-label="View">
      {VIEWS.map((v) => (
        <button key={v.view} className="ip-view-btn" aria-pressed={view === v.view} onClick={() => onPick(v.view)}>
          {v.label}
        </button>
      ))}
    </div>
  );
}
