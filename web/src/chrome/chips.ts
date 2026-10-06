import type { Session } from '../../../src/core/types';

/** A slot's place in the row: a session with no slot yet has no letter, so it goes after every lettered one. */
const rank = (slot: number | null) => (slot === null ? Number.POSITIVE_INFINITY : slot);

/**
 * The session row's order: by slot, so by letter (A, B, C…), whatever order the server lists them in (it puts the
 * session seen last first). Sessions with no slot yet keep the order they were given. Returns a new array.
 */
export function chipOrder<T extends Pick<Session, 'slot'>>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => (a.slot === b.slot ? 0 : rank(a.slot) - rank(b.slot)));
}
