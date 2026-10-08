import { describe, expect, it } from 'vitest';
import { parseGoTo, type StepHit } from '../../src/core/goto';
import { goToMessage, hitLabel, isGoToChord, pickHit } from '../../web/src/chrome/goToText';

const hit = (extra: Partial<StepHit> = {}): StepHit => ({ id: 77, title: 'Play app signing', status: 'active', projectId: 3, projectSlug: 'ingame', projectName: 'InGame', projectStatus: 'active', ...extra });

describe('hitLabel', () => {
  it('names the step by #id and title, then its project, saying so when that is archived', () => {
    expect(hitLabel(hit())).toBe('#77 Play app signing, InGame');
    expect(hitLabel(hit({ projectStatus: 'archived' }))).toBe('#77 Play app signing, InGame (archived)');
  });
});

describe('goToMessage', () => {
  it('says "No step #77" once Enter found nothing at that id, and only while the text still names it', () => {
    expect(goToMessage(parseGoTo('#77'), { hits: [] }, 77)).toBe('No step #77');
    expect(goToMessage(parseGoTo(' 77 '), { hits: [] }, 77)).toBe('No step #77');
    expect(goToMessage(parseGoTo('#7'), { hits: [] }, 77)).toBe('');
    // Before Enter, an id that finds nothing says nothing: typing 77 passes through 7.
    expect(goToMessage(parseGoTo('#77'), { hits: [] }, null)).toBe('');
  });

  it('says when words match no title, once the answer for them is in', () => {
    expect(goToMessage(parseGoTo('signing'), { hits: [] }, null)).toBe('No step titles match');
    expect(goToMessage(parseGoTo('signing'), null, null)).toBe('');
  });

  it('counts the steps listed, for a screen reader as much as the eye', () => {
    expect(goToMessage(parseGoTo('signing'), { hits: [hit()] }, null)).toBe('1 step');
    expect(goToMessage(parseGoTo('signing'), { hits: [hit(), hit({ id: 78 })] }, null)).toBe('2 steps');
    expect(goToMessage(parseGoTo('#77'), { hits: [hit()] }, null)).toBe('1 step');
    // Before the answer for the text as it is now, no count: the list on screen may be an older one.
    expect(goToMessage(parseGoTo('signing'), null, null)).toBe('');
  });

  it("says why a search failed, and nothing for an empty field", () => {
    expect(goToMessage(parseGoTo('signing'), { hits: [], error: 'HTTP 500' }, null)).toBe("Couldn't search: HTTP 500");
    expect(goToMessage(parseGoTo(''), null, null)).toBe('');
  });
});

describe('isGoToChord', () => {
  const press = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it('is Ctrl+K or Cmd+K, either case, with nothing else held', () => {
    expect(isGoToChord(press('k', { ctrlKey: true }))).toBe(true);
    expect(isGoToChord(press('K', { ctrlKey: true }))).toBe(true);
    expect(isGoToChord(press('k', { metaKey: true }))).toBe(true);
    expect(isGoToChord(press('k'))).toBe(false);
    expect(isGoToChord(press('k', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isGoToChord(press('k', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isGoToChord(press('j', { ctrlKey: true }))).toBe(false);
    // An autofill keydown carries no key.
    expect(isGoToChord(press(undefined as unknown as string, { ctrlKey: true }))).toBe(false);
  });
});

describe('pickHit', () => {
  const list = [hit({ id: 1 }), hit({ id: 2 }), hit({ id: 3 })];

  it('picks the highlighted step by id, wherever it sits in the list now', () => {
    expect(pickHit(list, 2)?.id).toBe(2);
    expect(pickHit([list[2], list[1]], 2)?.id).toBe(2);
  });

  it('picks the first when nothing is highlighted, or when the highlight is not in the newer list', () => {
    expect(pickHit(list, undefined)?.id).toBe(1);
    expect(pickHit([list[2], list[0]], 2)?.id).toBe(3);
    expect(pickHit([], 2)).toBeUndefined();
  });
});
