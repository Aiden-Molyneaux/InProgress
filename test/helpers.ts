import { openDb } from '../src/server/db/connection';
import { createCtx, type Ctx } from '../src/server/db/tx';

/** In-memory database with a clock that advances one second per call. */
export function makeCtx(start = '2026-09-27T12:00:00.000Z'): Ctx {
  const db = openDb(':memory:');
  let t = Date.parse(start);
  return createCtx(db, () => new Date((t += 1000)).toISOString());
}
