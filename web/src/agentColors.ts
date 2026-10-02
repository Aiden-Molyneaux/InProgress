import { useMemo, useRef } from 'react';
import type { ProjectSnapshot } from '../../src/core/types';

/**
 * Subagent badge colours. White text reads at 4.5:1 or better on each, and none is a colour the canvas already uses
 * for something (clay sessions, blue active, green done, amber needs-you, red blocked, purple resources).
 */
export const AGENT_COLORS = ['#5856d6', '#0b7285', '#c2255c', '#8c6239', '#5c7a00'];

export const agentKey = (sessionId: string, agentId: string) => `${sessionId}:${agentId}`;

/** FNV-1a, for the slot a subagent would like: the same subagent tends to the same colour. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Colour slots for the subagents in view, by key. One that has a slot keeps it. A newcomer takes the slot it would
 * like, or the next free one, so subagents seen together differ while there are slots to go round.
 */
export function assignSlots(prev: ReadonlyMap<string, number>, keys: string[], size = AGENT_COLORS.length): Map<string, number> {
  const slots = new Map<string, number>();
  const used = new Set<number>();
  for (const k of keys) {
    const slot = prev.get(k);
    if (slot === undefined) continue;
    slots.set(k, slot);
    used.add(slot);
  }
  for (const k of keys) {
    if (slots.has(k)) continue;
    const start = hash(k) % size;
    let slot = start;
    for (let i = 0; i < size; i++) {
      if (used.has((start + i) % size)) continue;
      slot = (start + i) % size;
      break;
    }
    slots.set(k, slot);
    used.add(slot);
  }
  return new Map(keys.map((k) => [k, slots.get(k)!]));
}

/** Each subagent's colour in the snapshot, by agentKey. A subagent keeps its colour for as long as it stays in view. */
export function useAgentColors(snapshot: ProjectSnapshot | null): ReadonlyMap<string, string> {
  const keys = (snapshot?.sessions ?? []).flatMap((s) => s.subagents.map((a) => agentKey(s.id, a.agentId)));
  const signature = keys.join('\n');
  const slots = useRef<ReadonlyMap<string, number>>(new Map());
  return useMemo(() => {
    slots.current = assignSlots(slots.current, signature ? signature.split('\n') : []);
    return new Map([...slots.current].map(([k, slot]) => [k, AGENT_COLORS[slot]]));
  }, [signature]);
}
