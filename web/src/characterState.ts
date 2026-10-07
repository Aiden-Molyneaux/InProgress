// The Simple character's pure helpers. No DOM and no React, so test/web/character.test.ts can import this file.
import type { Session, SessionState, SubagentInfo } from '../../src/core/types';

export type CharacterState = 'work' | 'idle' | 'wait' | 'ended';
/** 14 is a kin on a session chip, 16 a kin on a card, 18 a chip, 20 and 24 a lead. */
export type CharacterSize = 14 | 16 | 18 | 20 | 24;

const BY_SESSION: Record<SessionState, CharacterState> = { working: 'work', idle: 'idle', permission: 'wait', ended: 'ended' };

/** A session's state as its character's (working, idle, permission give work, idle, wait); a subagent works until it stops. */
export function characterState(who: Pick<Session, 'state'> | Pick<SubagentInfo, 'endedAt'>): CharacterState {
  return 'state' in who ? BY_SESSION[who.state] : who.endedAt === null ? 'work' : 'ended';
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
