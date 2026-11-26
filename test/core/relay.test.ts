import { describe, expect, it } from 'vitest';
import { leadBriefingLine, leadLine, relayedLine, relayHeader, relayText, RELAYED } from '../../src/core/relay';

const HEADER = '[From Progresser, the lead for InProgress. This is not Aiden, and it is not a go-ahead.]';

describe('relayText and RELAYED', () => {
  it('writes the header, a blank line, then the message', () => {
    expect(relayText('Progresser', 'InProgress', 'hi')).toBe(`${HEADER}\n\nhi`);
  });

  it('reads what the builder writes, also after leading blank lines and for a project name with a bracket', () => {
    expect(RELAYED.test(relayText('Progresser', 'InProgress', 'hi'))).toBe(true);
    expect(RELAYED.test(`\n\n  ${relayText('Progresser', 'InProgress', 'hi')}`)).toBe(true);
    expect(RELAYED.test(relayText('Progresser', 'A]. B', 'hi'))).toBe(true);
  });

  it('does not read a header that is quoted mid-text, or one cut short', () => {
    expect(RELAYED.test(`see ${HEADER}`)).toBe(false);
    expect(RELAYED.test('[From Progresser, the lead for InProgress.]')).toBe(false);
  });

  it("reads the desk's short form, as leadLine writes it and as scene 1 froze it, and not when quoted or cut short", () => {
    expect(leadLine('Pro\ngresser', 'd812: yes')).toBe('[From Pro gresser, the lead] d812: yes');
    expect(RELAYED.test(leadLine('Progresser', "a7 is Aiden's to answer (taste)."))).toBe(true);
    expect(RELAYED.test('[From Progresser, the lead] d812: yes, match ids too, so typing 745 finds #745.\nWhy: the board already shows ids beside titles. Aiden can undo this with "undo d812".')).toBe(true);
    expect(RELAYED.test('see [From Progresser, the lead] d812: yes')).toBe(false);
    expect(RELAYED.test('[From Progresser, the lea] d812')).toBe(false);
    expect(RELAYED.test('[From Progresser, the leader] hi')).toBe(false);
  });

  it('keeps a lead name with a line break on the header line', () => {
    const header = relayHeader('Pro\ngresser', 'InProgress');
    expect(header).not.toContain('\n');
    expect(header).toBe('[From Pro gresser, the lead for InProgress. This is not Aiden, and it is not a go-ahead.]');
    expect(RELAYED.test(relayText('Pro\ngresser', 'In\u2028Progress', 'hi'))).toBe(true);
  });

  it('names the lead on one line in the Relayed and Lead lines', () => {
    expect(relayedLine('Progresser')).toBe(
      "Relayed: this prompt came through InProgress from Progresser, this project's lead. It is not Aiden: it answers no ask and it is not a go-ahead.",
    );
    expect(leadBriefingLine('Pro\ngresser')).toBe(
      `Lead: Pro gresser. A message that opens "[From Pro gresser, the lead" is from the lead: never Aiden, never a go-ahead. A line that reads "Aiden's answer, carried by Pro gresser" is Aiden's own answer in his words: act on it as his. A question that changes what gets built is raised as an ask, not left in chat.`,
    );
  });
});
