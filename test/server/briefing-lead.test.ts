import { describe, expect, it } from 'vitest';
import { leadBriefingLine } from '../../src/core/relay';
import { renderBriefing } from '../../src/server/briefing';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, changeProject, createProject, setProjectLead } from '../../src/server/repo/projects';
import { clearBriefingDue } from '../../src/server/repo/sessions';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { claimStep, enrollSession, orchestrate } from '../../src/server/session-flow';
import { makeCtx } from '../helpers';

const CLI = 'C:/personal/InProgress/dist/cli/main.js';
const PLAN_EDIT = /^Plan edits go through the inprogress-scribe agent/;

/** A scoped project, led by Progresser unless `lead` is null, with one step and an enrolled session per id. */
function setup(lead: string | null = 'Progresser') {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Build tabs' }] });
  changeProject(ctx, 'test', project.slug, { briefingMode: 'scoped' });
  if (lead !== null) setProjectLead(ctx, 'window', project.slug, lead);
  const join = (id: string) => {
    enrollSession(ctx, `scribe:${id}`, id, project.slug);
    clearBriefingDue(ctx, id);
  };
  const brief = (id: string) => renderBriefing(getProjectSnapshot(ctx, project.slug), id, Date.parse(ctx.now()), { checkOld: true, cli: CLI }).split('\n');
  return { ctx, project, step, join, brief };
}

describe('the Lead line in a worker briefing', () => {
  it("follows the Role line of a claimed worker in a led project, before the plan-edit line", () => {
    const t = setup();
    t.join('s1');
    claimStep(t.ctx, 'session:s1', 's1', t.step.id);
    const lines = t.brief('s1');
    expect(lines[1]).toBe(`Role: worker on #${t.step.id}.`);
    expect(lines[2]).toBe(leadBriefingLine('Progresser'));
    expect(lines[3]).toMatch(PLAN_EDIT);
    expect(lines.filter((l) => l.startsWith('Lead:'))).toHaveLength(1);
  });

  it('is absent with no lead: the plan-edit line is third', () => {
    const t = setup(null);
    t.join('s1');
    claimStep(t.ctx, 'session:s1', 's1', t.step.id);
    const lines = t.brief('s1');
    expect(lines[2]).toMatch(PLAN_EDIT);
    expect(lines.some((l) => l.startsWith('Lead:'))).toBe(false);
  });

  it('is absent for an unclaimed worker and an orchestrator in a led project', () => {
    const t = setup();
    t.join('s1');
    t.join('s2');
    orchestrate(t.ctx, 'session:s2', 's2', { status: false });
    for (const id of ['s1', 's2']) {
      const lines = t.brief(id);
      expect(lines[2], id).toMatch(PLAN_EDIT);
      expect(lines.some((l) => l.startsWith('Lead:')), id).toBe(false);
    }
    expect(t.brief('s2')[1]).toMatch(/^Role: orchestrator\./);
    expect(t.brief('s1')[1]).toBe('Role: worker, no step claimed.');
  });
});
