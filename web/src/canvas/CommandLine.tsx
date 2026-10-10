import type { CSSProperties } from 'react';
import type { CommandInfo, Session } from '../../../src/core/types';
import { familyVar } from '../family';
import { commandLineParts } from '../live';
import { WorkDoneRow, type WorkDoneRowProps } from './WorkDoneRow';

export interface CommandLineProps {
  session: Pick<Session, 'slot' | 'subagents'>;
  /** The session's commands on this step, in the layout's order (LayoutCommandsItem.taskIds, resolved). */
  commands: CommandInfo[];
  now: number;
  /** The card's done row, when this is the card's last line: it sits at the line's right end. */
  done: WorkDoneRowProps | null;
}

/**
 * A session's background commands on one step as one muted line: `▸ a3 · npm run test:e2e +4 · 12m`. The mark is `▸`
 * while one counts as work, `◦` while only servers run, `✓` or `!` once all have ended. The tag wears the session's hue.
 * A serving or ended line goes faint. The group's title and accessible name list every command, one per line (not role=img: that would hide the done toggle).
 */
export function CommandLine({ session, commands, now, done }: CommandLineProps) {
  const { mark, tag, label, when, serving, ended, title } = commandLineParts(session, commands, now);
  return (
    <div
      className={['ip-commands', serving && 'serving', ended && 'ended'].filter(Boolean).join(' ')}
      style={{ '--fam': familyVar(session.slot) } as CSSProperties}
      role="group"
      title={title}
      aria-label={title}
    >
      <span className="ip-commands-text">
        <span className="ip-cmd-mark">{mark}</span>{' '}
        {tag && (
          <>
            <span className="ip-commands-mono ip-cmd-tag">{tag}</span>
            {' · '}
          </>
        )}
        <span className="ip-commands-mono">{label}</span>
        {when && (
          <>
            {' · '}
            <span className="ip-commands-mono">{when}</span>
          </>
        )}
      </span>
      {done && <WorkDoneRow {...done} />}
    </div>
  );
}
