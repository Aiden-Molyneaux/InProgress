/** What a desk turn answers: decide it, bring it to Aiden, or leave it to the landing check (a card). */
export type Verdict = 'DECIDE' | 'AIDEN' | 'CARD';

/** The kinds each verdict may carry. */
export const VERDICT_KINDS: Record<Verdict, readonly string[]> = {
  DECIDE: ['PRODUCT', 'TECHNICAL'],
  AIDEN: ['TASTE', 'DIRECTION', 'CANNOT-BE-TAKEN-BACK'],
  CARD: ['NONE'],
};

export interface ParsedVerdict {
  verdict: Verdict;
  kind: string;
  answer: string;
  why: string;
}

export type VerdictResult = { ok: true; value: ParsedVerdict } | { ok: false; reason: string };

/**
 * Reads a turn's four-line answer: the last four non-empty lines must be the verdict (DECIDE, AIDEN or CARD, in
 * capitals), `KIND: ...` with a kind its verdict allows, `ANSWER: ...` and `WHY: ...`, each with text. Anything before
 * them is ignored. Anything else is a failure with the reason.
 */
export function parseVerdict(text: string): VerdictResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length < 4) return { ok: false, reason: `the answer has ${lines.length} non-empty lines, not four` };
  const [head, kindLine, answerLine, whyLine] = lines.slice(-4) as [string, string, string, string];
  if (!Object.hasOwn(VERDICT_KINDS, head)) return { ok: false, reason: `the verdict line is "${head}", not DECIDE, AIDEN or CARD` };
  const verdict = head as Verdict;
  const field = (line: string, name: string): string | undefined => (line.startsWith(`${name}:`) ? line.slice(name.length + 1).trim() : undefined);
  const kind = field(kindLine, 'KIND');
  if (kind === undefined) return { ok: false, reason: `the second line is "${kindLine}", not KIND: ...` };
  if (!VERDICT_KINDS[verdict].includes(kind)) return { ok: false, reason: `KIND ${kind || '(empty)'} is not one of ${VERDICT_KINDS[verdict].join(', ')} for ${verdict}` };
  const answer = field(answerLine, 'ANSWER');
  if (!answer) return { ok: false, reason: `the third line is "${answerLine}", not ANSWER: with text` };
  const why = field(whyLine, 'WHY');
  if (!why) return { ok: false, reason: `the fourth line is "${whyLine}", not WHY: with text` };
  return { ok: true, value: { verdict, kind, answer, why } };
}
