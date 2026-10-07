import { isReader, type Session, type SubagentInfo } from '../../../src/core/types';

/** A slot's place in the row: a session with no slot yet has no letter, so it goes after every lettered one. */
const rank = (slot: number | null) => (slot === null ? Number.POSITIVE_INFINITY : slot);

/**
 * The session row's order: by slot, so by letter (A, B, C…), whatever order the server lists them in (it puts the
 * session seen last first). Sessions with no slot yet keep the order they were given. Returns a new array.
 */
export function chipOrder<T extends Pick<Session, 'slot'>>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => (a.slot === b.slot ? 0 : rank(a.slot) - rank(b.slot)));
}

/** How many kin a chip draws after its letter. Past that, a muted `+n` stands for the rest. */
export const CHIP_KIN = 3;

/** The kin a chip draws, and how many more run than it draws. */
export interface ChipKin<T> {
  shown: T[];
  more: number;
}

/**
 * The kin a session chip draws after its letter: its workers that still run, in the session's order (by start, as the
 * server lists them), at most CHIP_KIN. `more` counts the rest. Readers never get a kin, as on the cards, and a worker
 * that has stopped, however it stopped (the usage limit too), leaves the chip: it shows who is at work now.
 */
export function chipKin<T extends Pick<SubagentInfo, 'agentType' | 'endedAt'>>(subagents: readonly T[]): ChipKin<T> {
  const running = subagents.filter((a) => a.endedAt === null && !isReader(a.agentType));
  return { shown: running.slice(0, CHIP_KIN), more: Math.max(0, running.length - CHIP_KIN) };
}
