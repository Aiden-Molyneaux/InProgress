// The Simple character's pure helpers. No DOM and no React, so test/web/character.test.ts can import this file.
import { sessionActivity, type Activity } from '../../src/core/activity';
import type { Session, SubagentInfo } from '../../src/core/types';

export type CharacterState = 'work' | 'busy' | 'idle' | 'wait' | 'ended';
/** 14 is a kin on a session chip, 16 a kin on a card, 18 a chip, 20 and 24 a lead. */
export type CharacterSize = 14 | 16 | 18 | 20 | 24;

const BY_ACTIVITY: Record<Activity, CharacterState> = { working: 'work', busy: 'busy', idle: 'idle', permission: 'wait', ended: 'ended' };

/**
 * A session's activity as its character's (working, busy, idle, permission give work, busy, idle, wait): an idle session
 * with a running worker or a command that counts as work at `now` is busy. A subagent works until it stops.
 */
export function characterState(who: Pick<Session, 'state' | 'subagents' | 'commands'> | Pick<SubagentInfo, 'endedAt'>, now: number): CharacterState {
  return 'state' in who ? BY_ACTIVITY[sessionActivity(who, now)] : who.endedAt === null ? 'work' : 'ended';
}

/** A negative animation-delay in ms, in (-periodMs, 0], from a 32-bit FNV-1a hash of the seed: stable per seed. */
export function phaseDelay(seed: string, periodMs: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return -(h % periodMs) || 0;
}
