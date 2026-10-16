import { commandShown, orderCommands, sessionActivity } from '../../../src/core/activity';
import type { BoardRow } from '../../../src/core/board';
import { agentTag, isReader, sessionDisplayTitle, sessionTag, type Session } from '../../../src/core/types';
import { Character } from '../Character';
import { characterState } from '../characterState';
import { commandLineParts, kinTitle, leadTitle, runTime, withoutOwnId, WORDS } from '../live';
import { endedLine, LabelChip, rowClick, StepLine, StepMarks } from './Marks';
import type { BandProps } from './bandProps';

const hue = (slot: number | null) => `var(--family-${(slot ?? 0) % 6})`;

/** One session as a message: character, letter, state word, its current task as the main line, its subagents at the right. */
function SessionMessage({ session, row, snapshot, now }: { session: Session; row: BoardRow; snapshot: BandProps['snapshot']; now: number }) {
  const activity = sessionActivity(session, now);
  const task = snapshot.workItems
    .filter((w) => w.sessionId === session.id && w.agentId === '' && w.status === 'in_progress')
    .sort((a, b) => (a.nodeId === row.node.id ? 0 : 1) - (b.nodeId === row.node.id ? 0 : 1) || a.position - b.position)[0];
  const kin = session.subagents.filter((a) => a.endedAt === null && !isReader(a.agentType));
  const commands = orderCommands(session.commands.filter((c) => commandShown(c, now)));
  const line = commands.length ? commandLineParts(session, commands, now) : null;
  return (
    <div className="ip-msg ip-session" data-session={session.id}>
      <span title={leadTitle(session, now)}>
        <Character size={24} state={characterState(session, now)} slot={session.slot} seed={session.id} />
      </span>
      <div className="ip-msg-body">
        <div className="ip-msg-head">
          <b className="ip-tag" style={{ color: hue(session.slot) }}>{sessionTag(session.slot) || '?'}</b>{' '}
          <span className={`ip-state-word ${activity}`}>{WORDS[activity]}</span>
          {row.driver && <span className="ip-role"> · {row.driver.id === session.id ? 'drives' : 'helping'}</span>}
          <span className="ip-quiet"> · {sessionDisplayTitle(session)}</span>
        </div>
        {task && <p className="ip-main-line">{withoutOwnId(task.subject, row.node.id)}</p>}
        {line && (
          <div className={`ip-commands${line.serving ? ' serving' : ''}${line.ended ? ' ended' : ''}`} role="group" title={line.title} aria-label={line.title}>
            {`${line.mark} ${line.tag} · ${line.label}${line.when ? ` · ${line.when}` : ''}`}
          </div>
        )}
      </div>
      {kin.length > 0 && (
        <div className="ip-kin" role="group" aria-label={`${kin.length} subagent${kin.length > 1 ? 's' : ''}`}>
          {kin.map((a) => (
            <span key={a.agentId} className="ip-kin-chip" role="img" aria-label={kinTitle(a, session.slot, now, row.node.id)} title={kinTitle(a, session.slot, now, row.node.id)}>
              <Character size={14} state={characterState(a, now)} slot={session.slot} seed={`${session.id}:${a.agentId}`} />
              <span className="ip-agent-tag" style={{ ['--fam' as string]: hue(session.slot) }}>{agentTag(session.slot, a.ordinal)}</span>
              <span className="ip-time">{runTime(a.runStartedAt, now)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Now: each step with its sessions first, then the step quoted under them (spec 2.8). */
export function NowColumn({ snapshot, board, now, wide, onOpenNode, onOpenResource }: BandProps) {
  if (board.now.length === 0) return <p className="ip-quiet ip-empty-line">Nothing is in flight</p>;
  const slotOf = (id: string) => snapshot.sessions.find((s) => s.id === id)?.slot ?? null;
  const resourceCount = (id: number) => snapshot.resources.filter((r) => r.nodeId === id).length;
  return (
    <ul className="ip-now-list">
      {board.now.map((row) => {
        const n = resourceCount(row.node.id);
        const ended = endedLine(row, snapshot.pastSessions, slotOf, now);
        return (
          <li key={row.node.id} className="ip-row ip-now-row" data-node={row.node.id} onClick={rowClick('now', () => onOpenNode(row.node.id))}>
            {row.sessions.length > 0 ? (
              row.sessions.map((s) => <SessionMessage key={s.id} session={s} row={row} snapshot={snapshot} now={now} />)
            ) : (
              <div className="ip-msg ip-nosession">
                <span className="ip-avatar-dashed" aria-hidden="true" />
                <div className="ip-msg-body">
                  <div className="ip-msg-head">
                    <b>No session</b> · <span className="ip-you">YOU</span>
                  </div>
                  <p className="ip-main-line">Your step: nobody is on it</p>
                </div>
              </div>
            )}
            <div className="ip-quote">
              <StepLine node={row.node} />
              <LabelChip label={row.node.label} />
              {wide && row.crumb.length > 0 && <span className="ip-crumb">{row.crumb.map((c) => c.title).join(' › ')}</span>}
              {n > 0 && <span className="ip-docs" title={`${n} resource${n > 1 ? 's' : ''}`}>{`▤ ${n}`}</span>}
              <StepMarks row={row} now={now} onOpenResource={onOpenResource} />
            </div>
            {ended && <div className="ip-system-line">{ended}</div>}
          </li>
        );
      })}
    </ul>
  );
}
