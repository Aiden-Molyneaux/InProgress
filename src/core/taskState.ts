import { isLive, type Board, type BoardInput, type BoardRow, type Column } from './board';
import { buildIndex, dfsOrder } from './tree';
import { TRAIL_MS, type Session } from './types';

/** The one state a Board box shows (the shared task box). */
export const TASK_STATES = ['backlog', 'ready', 'working', 'idle', 'unattended', 'blocked', 'question', 'permission', 'review', 'done'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** The Board cell a box sits in: one per task. */
export type TaskCell = 'needs' | 'next' | 'now' | 'done' | 'backlog';

/** The states that carry a task hue: every state but backlog and done. */
export const COLOURED: ReadonlySet<TaskState> = new Set(TASK_STATES.filter((s) => s !== 'backlog' && s !== 'done'));
/** How many task hues there are. */
export const HUES = 7;

export interface TaskBox {
  /** Null only for a focusless permission wait, whose `session` is set. */
  row: BoardRow | null;
  session: Session | null;
  cell: TaskCell;
  state: TaskState;
}

/** The state of one row (the rules, first match wins). The window and the server's reconcile both call this. */
export function taskStateOf(row: BoardRow, input: BoardInput, now: number): TaskState {
  const { node } = row;
  if (row.sessions.some((s) => s.state === 'permission') || row.asks.some((a) => a.kind === 'permission')) return 'permission';
  if (row.asks.length) return row.asks[0].kind;
  if (node.status === 'done') return 'done';
  if (row.sessions.some((s) => s.state === 'working')) return 'working';
  if (node.status === 'blocked') return 'blocked';
  if (row.sessions.length) return 'idle';
  if (node.status === 'active') {
    if (node.assignee === 'me') return 'unattended';
    let newest: string | null = null;
    for (const p of input.pastSessions) if (p.focusNodeId === node.id && (newest === null || p.endedAt > newest)) newest = p.endedAt;
    if (newest !== null && now - Date.parse(newest) <= TRAIL_MS) return 'unattended';
  }
  if (row.column === 'next') return 'ready';
  return 'backlog';
}

const cellOf = (state: TaskState, column: Column): TaskCell => {
  switch (state) {
    case 'permission': case 'question': case 'review': return 'needs';
    case 'done': return 'done';
    case 'working': case 'idle': case 'unattended': return 'now';
    case 'ready': return 'next';
    case 'backlog': return 'backlog';
    case 'blocked': return column === 'done' ? 'done' : column;
  }
};

/** Every box on the Board by cell, in each cell's order. A task is in exactly one cell. */
export function taskBoxes(board: Board, input: BoardInput, now: number): Record<TaskCell, TaskBox[]> {
  const out: Record<TaskCell, TaskBox[]> = { needs: [], next: [], now: [], done: [], backlog: [] };
  const boxOf = (row: BoardRow): TaskBox => {
    const state = taskStateOf(row, input, now);
    const session = state === 'permission' ? (row.sessions.find((s) => s.state === 'permission') ?? null) : (row.sessions[0] ?? null);
    return { row, session, cell: cellOf(state, row.column), state };
  };
  const boxes = new Map<number, TaskBox>();
  for (const row of board.byId.values()) boxes.set(row.node.id, boxOf(row));

  const needTime = (b: TaskBox): number => {
    const row = b.row;
    if (!row) return Date.parse(b.session!.lastSeenAt);
    const times = row.asks.map((a) => Date.parse(a.raisedAt));
    for (const s of row.sessions) if (s.state === 'permission') times.push(Date.parse(s.lastSeenAt));
    return Math.min(...times);
  };
  const needs = [...boxes.values()].filter((b) => b.cell === 'needs');
  for (const s of input.sessions) {
    if (s.focusNodeId === null && s.state === 'permission' && isLive(s, now)) needs.push({ row: null, session: s, cell: 'needs', state: 'permission' });
  }
  out.needs = needs.sort((a, b) =>
    needTime(a) - needTime(b) || (a.row ? 0 : 1) - (b.row ? 0 : 1) || (a.row && b.row ? a.row.node.id - b.row.node.id : (a.session!.id < b.session!.id ? -1 : a.session!.id > b.session!.id ? 1 : 0)));

  const inCell = (rows: BoardRow[], cell: TaskCell): TaskBox[] =>
    rows.map((r) => boxes.get(r.node.id)!).filter((b) => b.cell === cell);
  out.next = inCell(board.next, 'next');
  const nowBoxes = inCell(board.now, 'now');
  const order = dfsOrder(buildIndex(input.nodes));
  const fromElsewhere = [...boxes.values()]
    .filter((b) => b.cell === 'now' && b.row!.column !== 'now')
    .sort((a, b) => (order.get(a.row!.node.id) ?? 0) - (order.get(b.row!.node.id) ?? 0));
  out.now = [...nowBoxes, ...fromElsewhere];
  out.done = inCell(board.done, 'done');
  out.backlog = inCell(board.backlog, 'backlog');
  return out;
}
