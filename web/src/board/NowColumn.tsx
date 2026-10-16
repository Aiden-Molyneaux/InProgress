import { commandShown, orderCommands } from '../../../src/core/activity';
import type { BoardRow } from '../../../src/core/board';
import { isReader, type Session } from '../../../src/core/types';
import { agentName, commandLineParts, runTime, withoutOwnId } from '../live';
import { endedLine } from './Marks';
import type { BandProps } from './bandProps';
import { SessionLine, TaskBox } from './TaskBox';

/** One session on a step: its line, then a block with its in-progress task, its commands line and its running subagents. */
function SessionPart({ session, row, snapshot, now }: { session: Session; row: BoardRow; snapshot: BandProps['snapshot']; now: number }) {
  const task = snapshot.workItems
    .filter((w) => w.sessionId === session.id && w.agentId === '' && w.status === 'in_progress')
    .sort((a, b) => (a.nodeId === row.node.id ? 0 : 1) - (b.nodeId === row.node.id ? 0 : 1) || a.position - b.position)[0];
  const kin = session.subagents.filter((a) => a.endedAt === null && !isReader(a.agentType));
  const commands = orderCommands(session.commands.filter((c) => commandShown(c, now)));
  const line = commands.length ? commandLineParts(commands, now) : null;
  return (
    <>
      <SessionLine session={session} area="now" />
      {(task || line || kin.length > 0) && (
        <div className="ip-block" data-session={session.id}>
          {task && <p className="ip-card-main">{withoutOwnId(task.subject, row.node.id)}</p>}
          {line && (
            <div className={`ip-cmd${line.serving ? ' serving' : ''}${line.ended ? ' ended' : ''}`} role="group" title={line.title} aria-label={line.title}>
              {`${line.mark} ${line.label}${line.when ? ` · ${line.when}` : ''}`}
            </div>
          )}
          {kin.length > 0 && (
            <div className="ip-kin-count" title={kin.map((a) => `${agentName(a, row.node.id)} · ${runTime(a.runStartedAt, now)}`).join('\n')}>
              {`${kin.length} subagent${kin.length > 1 ? 's' : ''}`}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Now: one box per step in flight, with each session on it; a step nobody is on says so (spec 2.8). */
export function NowColumn({ snapshot, boxes, now, onOpenNode, onOpenResource }: BandProps) {
  if (boxes.now.length === 0) return <p className="ip-quiet ip-empty-line">Nothing is in flight</p>;
  return (
    <ul className="ip-list">
      {boxes.now.map((box) => {
        const row = box.row!;
        const sessions = row.sessions;
        return (
          <TaskBox
            key={row.node.id}
            box={box}
            now={now}
            area="now"
            docs={snapshot.resources.filter((r) => r.nodeId === row.node.id).length}
            system={endedLine(row, snapshot.pastSessions, now)}
            onOpenNode={onOpenNode}
            onOpenResource={onOpenResource}
          >
            {sessions.length > 0 ? (
              sessions.map((s) => <SessionPart key={s.id} session={s} row={row} snapshot={snapshot} now={now} />)
            ) : (
              <div className="ip-sess">
                <span className="ip-quiet">No session is on it</span>
              </div>
            )}
          </TaskBox>
        );
      })}
    </ul>
  );
}
