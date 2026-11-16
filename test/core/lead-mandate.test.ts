import { describe, expect, it } from 'vitest';
import { DECIDED_PREFIX, LEAD_MANDATE, decisionText, isDecisionLog, sessionMandateLines } from '../../src/core/lead-mandate';

const MANDATE = [
  'Your mandate',
  'The rule: if Aiden can undo it in one word and nothing is lost in the meantime, you decide and tell him afterwards. If not, it is his, and you bring it with a recommendation he can accept in one word.',
  'You decide, and tell him afterwards:',
  "- how a thing gets built: the approach, names, files, tests, the order of work inside a step. Answer a session's question from the intent record, the specs, the repo and the threads;",
  '- the bar for work that nothing shows on a screen: fixes, refactors, tests, docs, internal scripts;',
  '- what is next inside the current Phase, and in what order;',
  '- setting aside (parking) a step nobody is working on, with the reason; dropping a step only when its origin is proposed;',
  '- your own promises.',
  "Aiden's, always:",
  '- what cannot be undone: deleting data, a branch or a step he asked for; rewriting history; a release;',
  "- what touches his real data: the live InProgress home and window, a merge to main, a deploy, a migration, an installer, anything outside the project's folders;",
  '- what goes out to other people: a push, a PR, a message, an email, anything published or sent in his name;',
  '- what changes direction: the Goal, the Phase, what is out of scope, a standing ruling, dropping or reshaping a step he asked for;',
  '- what he would see or feel: anything on a screen or in a flow he uses, and the bar for it;',
  '- what costs money, adds an account or a service, or changes what an agent may do: permissions, access, your rules, this mandate;',
  '- anything the intent record marks as his.',
  'When you are not sure: if it can be undone, decide and say you were not sure. If it cannot, it is his. Never guess at a fact: find out, or say what you could not find.',
];

describe('LEAD_MANDATE', () => {
  it('is exactly the mandate, line by line, in plain ASCII', () => {
    expect(LEAD_MANDATE).toHaveLength(MANDATE.length);
    MANDATE.forEach((line, i) => expect(LEAD_MANDATE[i], `line ${i + 1}`).toBe(line));
    // eslint-disable-next-line no-control-regex
    for (const line of LEAD_MANDATE) expect(line).toMatch(/^[ -~]*$/);
  });
});

describe('sessionMandateLines', () => {
  it('is the two briefing lines, with the lead named, and the middle dot in the first', () => {
    const [a, b, ...rest] = sessionMandateLines('Progresser');
    expect(rest).toEqual([]);
    expect(a).toBe(
      'Mandate: decide for yourself what Aiden can undo in one word (how a thing gets built, names, files, tests, the bar for work nothing shows on a screen, a follow-up filed as proposed). Record each call in your next scribe brief as "log on #<id>: Decided for Aiden: <what> · <why>", and carry on. Do not stop to ask.',
    );
    expect(b).toBe(
      "Aiden's, always: what cannot be undone, his real data (the live home and window, a merge, a deploy, a migration, an installer), what goes out to other people, a change of direction, what he would see or feel, money and permissions. Raise those as an ask with your recommendation and the one word that accepts it. A question you cannot settle is a question ask: Progresser sees it first, and answers it or brings it to Aiden.",
    );
    // eslint-disable-next-line no-control-regex
    expect(b).toMatch(/^[ -~]*$/);
  });
});

describe('isDecisionLog and decisionText', () => {
  it('counts a log that opens with the prefix, in any case, after leading spaces', () => {
    expect(DECIDED_PREFIX).toBe('Decided for Aiden:');
    expect(isDecisionLog('Decided for Aiden: x')).toBe(true);
    expect(isDecisionLog('  decided for aiden: x')).toBe(true);
    expect(isDecisionLog('DECIDED FOR AIDEN: x')).toBe(true);
  });

  it('leaves out a log that has the phrase mid-sentence, or only part of it', () => {
    expect(isDecisionLog('We decided for Aiden: x')).toBe(false);
    expect(isDecisionLog('Decided: x')).toBe(false);
    expect(isDecisionLog('Decided for Aiden x')).toBe(false);
  });

  it('gives the text after the prefix, trimmed', () => {
    expect(decisionText('Decided for Aiden:   use tabs · less churn  ')).toBe('use tabs · less churn');
    expect(decisionText('  decided for aiden: x')).toBe('x');
  });
});
