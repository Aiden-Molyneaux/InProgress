import type { Board, BoardRow } from '../../../src/core/board';
import type { PastSession } from '../../../src/core/types';

/** A compact age for a Board row: "now", "5m", "3h", "2d". */
export function ageShort(iso: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The first sentence of a note: the first line that is not a heading (else the first heading), up to the first full stop, question or exclamation mark. */
export function firstSentence(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const body = lines.find((l) => !l.startsWith('#')) ?? lines[0] ?? '';
  const line = body.replace(/^[\s#>*_-]+/, '');
  const end = /[.!?](\s|$)/.exec(line);
  return end ? line.slice(0, end.index + 1) : line;
}

/** The hygiene count's tooltip: each marked step with its marks (`#53 no_outcome · #173 ended_open`). */
export function hygieneTitle(board: Pick<Board, 'marked'>): string {
  return board.marked.map((r: BoardRow) => `#${r.node.id} ${r.marks.join(' ')}`).join(' · ');
}

/** The grey system line for an `ended_open` step: "Its last session ended 3h ago without closing it". Null for any other row. */
export function endedLine(row: BoardRow, past: PastSession[], now: number): string | null {
  if (!row.marks.includes('ended_open')) return null;
  const last = past.filter((p) => p.focusNodeId === row.node.id).sort((a, b) => b.endedAt.localeCompare(a.endedAt))[0];
  if (!last) return null;
  return `Its last session ended ${ageShort(last.endedAt, now)} ago without closing it`;
}

/** A piece of a note: plain text, or a `#id` that names a step. */
export type NoteRun = { kind: 'text'; text: string } | { kind: 'ref'; id: number; text: string };

/**
 * A note's text split into runs. A `#<digits>` at a word start whose id `has` knows is a ref; an unknown id, or a hash
 * inside a word (`a#12`), stays text. Joining the runs' text gives the input back.
 */
export function splitRefs(text: string, has: (id: number) => boolean): NoteRun[] {
  const runs: NoteRun[] = [];
  let from = 0;
  for (const m of text.matchAll(/(?<![\w#])#(\d+)(?!\w)/g)) {
    const id = Number(m[1]);
    if (!has(id)) continue;
    if (m.index > from) runs.push({ kind: 'text', text: text.slice(from, m.index) });
    runs.push({ kind: 'ref', id, text: m[0] });
    from = m.index + m[0].length;
  }
  if (from < text.length) runs.push({ kind: 'text', text: text.slice(from) });
  return runs;
}

/** Whether a note says more than its first sentence: its text with whitespace collapsed is longer than that sentence. */
export function noteHasMore(content: string): boolean {
  return content.replace(/\s+/g, ' ').trim().length > firstSentence(content).length;
}
