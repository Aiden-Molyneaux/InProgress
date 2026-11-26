import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { deskSystemPrompt } from '../../src/server/lead/prompt';
import { createProject } from '../../src/server/repo/projects';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function prompt(): string {
  const ctx = createCtx(openDb(':memory:'), () => '2026-11-25T09:00:00.000Z');
  cleanups.push(() => void ctx.db.close());
  const project = createProject(ctx, 'test', { name: 'InGame' });
  return deskSystemPrompt(ctx, project);
}

// The exam on unseen cases (task 16, half A) found the lead deciding a power setting of Aiden's laptop, and accepting
// reviews of screens and pictures. The rule was narrowed on both; these lines hold it.
describe("the desk turn's rule after the exam's narrowing", () => {
  it("keeps Aiden's own computer his, however easy it is to switch back", () => {
    expect(prompt()).toContain('His computer is his too: its power and sleep settings, its system settings, and anything installed or changed on it outside the project\'s own folders, however easy it is to switch back.');
  });

  it('never accepts a review of something Aiden will see or feel', () => {
    const text = prompt();
    expect(text).toContain('A review that asks him to look at, try or accept something he will see or feel (a screen, a picture, words he reads, a design) is his even when the work looks finished and the checks are green: you never accept one for him.');
    expect(text).toContain('whether finished work meets what was asked (unless what was asked is a look or a feel: that is taste)');
  });
});
