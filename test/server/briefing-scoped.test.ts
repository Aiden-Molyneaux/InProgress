import { describe, expect, it } from 'vitest';
import { renderBriefing, renderStatusAnswer, renderStatusLine } from '../../src/server/briefing';
import { stepBlock } from '../../src/server/briefing-scoped';
import { clearAsk, raiseAsk } from '../../src/server/repo/asks';
import { addNodes, updateNode } from '../../src/server/repo/nodes';
import { addBinding, changeProject, createProject, setQueue } from '../../src/server/repo/projects';
import { addResource } from '../../src/server/repo/resources';
import { clearBriefingDue, findSession } from '../../src/server/repo/sessions';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { claimStep, enrollSession, handleHookEvent, setFocus } from '../../src/server/session-flow';
import { makeCtx } from '../helpers';

const CLI = 'C:/personal/InProgress/dist/cli/main.js';
const CLAIM = 'node C:/personal/InProgress/dist/cli/main.js claim <id> --session';

function setup(mode: 'full' | 'scoped' = 'scoped') {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame', playbook: 'Docs live in docs/planning.' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const [group] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Declutter', status: 'active' }] });
  const [step, ready1, ready2, ready3, askedStep, mine] = addNodes(ctx, 'test', {
    parentId: group.id,
    nodes: [{ title: 'Build tabs', label: 'ui' }, { title: 'Ready one' }, { title: 'Ready two' }, { title: 'Ready three' }, { title: 'Asked' }, { title: 'Aiden does', assignee: 'me' }],
  });
  const [childA, childB, childDone] = addNodes(ctx, 'test', { parentId: step.id, nodes: [{ title: 'Child A', status: 'active' }, { title: 'Child B' }, { title: 'Child done', status: 'done', outcome: 'ok' }] });
  if (mode === 'scoped') changeProject(ctx, 'test', project.slug, { briefingMode: 'scoped' });
  const join = (id: string, title?: string) => {
    enrollSession(ctx, `scribe:${id}`, id, project.slug, title);
    clearBriefingDue(ctx, id);
  };
  const snap = () => getProjectSnapshot(ctx, project.slug);
  const brief = (id: string) => renderBriefing(snap(), id, Date.parse(ctx.now()), { checkOld: true, cli: CLI }).split('\n');
  return { ctx, project, group, step, ready1, ready2, ready3, askedStep, mine, childA, childB, childDone, join, snap, brief };
}

describe('scoped worker with a claimed step', () => {
  it('carries the role, rules, the step block and the other sessions, and drops queue and later', () => {
    const t = setup();
    t.join('s1');
    t.join('s2', 'Store listing');
    const { ctx, step, childA, childB, group } = t;
    claimStep(ctx, 'session:s1', 's1', step.id);
    // An earlier session left a task, a handoff and a resource; one ask is open and one was answered since this session began.
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, focus_node_id, started_at, last_seen_at, ended_at) VALUES ('old', ?, 'ended', ?, ?, ?, ?)").run(t.project.id, step.id, ctx.now(), ctx.now(), ctx.now());
    ctx.db.prepare("INSERT INTO work_items (project_id, node_id, session_id, agent_id, task_key, subject, status, blocks, position, created_at, updated_at) VALUES (?,?,?,'','k','Wire the tabs','pending','[]',1,?,?)").run(t.project.id, step.id, 'old', ctx.now(), ctx.now());
    ctx.db.prepare("UPDATE work_items SET created_at = created_at").run();
    ctx.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = 'old'").run(ctx.now());
    const handoff = addResource(ctx, 'test', { nodeId: step.id, kind: 'doc', title: 'Handoff for tabs', content: 'x', purpose: 'handoff' });
    const note = addResource(ctx, 'test', { nodeId: step.id, kind: 'doc', title: 'Notes', content: 'y' });
    addResource(ctx, 'test', { nodeId: group.id, kind: 'doc', title: 'Elsewhere', content: 'z' });
    const open = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which port?', sessionId: 's1' });
    const answered = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'review', text: 'Look at the tabs', sessionId: 's1' });
    clearAsk(ctx, 'window', answered.id, 'looks good');
    handleHookEvent(ctx, 's1', { event: 'task-created', taskKey: '1', subject: 'Mine pending' });
    handleHookEvent(ctx, 's1', { event: 'task-created', taskKey: '2', subject: 'Mine doing' });
    handleHookEvent(ctx, 's1', { event: 'task-updated', taskKey: '2', status: 'in_progress' });

    const lines = t.brief('s1');
    expect(lines[0]).toMatch(/^\[InProgress\] This session is tracked in project "InGame" \(slug ingame\)\. Session id: s1\. You are session A\.$/);
    expect(lines[1]).toBe(`Role: worker on #${step.id}.`);
    expect(lines[2]).toMatch(/^Plan edits go through the inprogress-scribe agent/);
    expect(lines.slice(3, 5)).toEqual(['Playbook:', '  Docs live in docs/planning.']);
    const rules = lines.find((l) => l.startsWith('- Brief when:'))!;
    expect(rules).toContain(`a step starts ("${CLAIM} s1"; add --take-over when you inherit the step)`);
    expect(rules).not.toContain('queue:');
    expect(rules).not.toContain('later:');
    expect(rules).not.toContain('the plan or an order changes');
    const at = lines.indexOf('Your step: #' + t.project.rootNodeId + ' InGame › #' + group.id + ' Declutter');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at)).toEqual([
      `Your step: #${t.project.rootNodeId} InGame › #${group.id} Declutter`,
      `  #${step.id} ⧉ Build tabs · active (1/3)`,
      `    #${childA.id} Child A · active`,
      `    #${childB.id} Child B · todo`,
      '    ◐ Mine doing',
      '    ○ Mine pending',
      'Driver: you',
      `Handoff: r${handoff.id} "Handoff for tabs" (<1m)`,
      `Resources on #${step.id}: r${note.id} Notes · r${handoff.id} Handoff for tabs`,
      `Asks on #${step.id}: a${open.id} ? "Which port?" (open, <1m) · a${answered.id} ◎ "Look at the tabs" (answered: "looks good")`,
      `Left unfinished on #${step.id} by an earlier session: "Wire the tabs"`,
      'Other sessions here: B "Store listing" (working)',
    ]);
  });

  it('does not carry the Where things stand, Up next or Needs you lines', () => {
    const t = setup();
    t.join('s1');
    claimStep(t.ctx, 'session:s1', 's1', t.step.id);
    raiseAsk(t.ctx, 'test', { nodeId: t.askedStep.id, kind: 'question', text: 'Elsewhere?' });
    const text = t.brief('s1').join('\n');
    for (const head of ['Where things stand', 'Up next', 'Needs you', 'Recent resources']) expect(text, head).not.toContain(head);
  });

  it('puts a done step with a handoff in the block too, and reads a dropped focus as unclaimed', () => {
    const t = setup();
    t.join('s1');
    claimStep(t.ctx, 'session:s1', 's1', t.step.id);
    updateNode(t.ctx, 'test', t.step.id, { status: 'done', outcome: 'shipped' });
    expect(t.brief('s1')).toContain(`  #${t.step.id} ⧉ Build tabs · done (1/3)`);
    updateNode(t.ctx, 'test', t.step.id, { status: 'dropped' });
    expect(t.brief('s1')).toContain('Role: worker, no step claimed.');
  });

  it('caps open children at eight and tasks at five, counting the rest', () => {
    const t = setup();
    t.join('s1');
    addNodes(t.ctx, 'test', { parentId: t.step.id, nodes: Array.from({ length: 9 }, (_, i) => ({ title: `Extra ${i}` })) });
    claimStep(t.ctx, 'session:s1', 's1', t.step.id);
    for (let i = 1; i <= 7; i++) handleHookEvent(t.ctx, 's1', { event: 'task-created', taskKey: String(i), subject: `T${i}` });
    const block = stepBlock(t.snap(), t.step.id, findSession(t.ctx, 's1')!, Date.parse(t.ctx.now()));
    expect(block.filter((l) => l.startsWith('    #'))).toHaveLength(8);
    expect(block).toContain('    +3 more open');
    expect(block.filter((l) => /^ {4}[○◐] /.test(l))).toHaveLength(5);
  });

  it('names the driver: you for the driver, its tag, title and activity for a helper, nothing when driverless', () => {
    const t = setup();
    t.join('s1', 'Tabs work');
    t.join('s2');
    claimStep(t.ctx, 'session:s1', 's1', t.step.id);
    claimStep(t.ctx, 'session:s2', 's2', t.step.id);
    const block = (id: string) => stepBlock(t.snap(), t.step.id, findSession(t.ctx, id)!, Date.parse(t.ctx.now()));
    const driverLines = (id: string) => block(id).filter((l) => l.startsWith('Driver:'));
    expect(driverLines('s1')).toEqual(['Driver: you']);
    expect(driverLines('s2')).toEqual(['Driver: A "Tabs work" (working)']);
    // The Driver line sits after the step's children and tasks, before the handoff and asks.
    expect(block('s1').slice(0, 5)).toEqual([expect.stringMatching(/^Your step:/), `  #${t.step.id} ⧉ Build tabs · active (1/3)`, expect.stringMatching(/Child A/), expect.stringMatching(/Child B/), 'Driver: you']);
    t.ctx.db.prepare('UPDATE nodes SET driver_session_id = NULL WHERE id = ?').run(t.step.id);
    expect(driverLines('s2')).toEqual([]);
  });
});

describe('scoped worker with no step', () => {
  it('offers up to three ready Next steps, its own queue first, and the claim command', () => {
    const t = setup();
    t.join('s1');
    t.join('s2');
    setQueue(t.ctx, 'scribe:s1', t.project.slug, [t.ready1.id, t.ready2.id, t.ready3.id, t.askedStep.id, t.mine.id], 'unowned');
    setQueue(t.ctx, 'scribe:s2', t.project.slug, [t.ready3.id], { sessionId: 's2' });
    raiseAsk(t.ctx, 'test', { nodeId: t.askedStep.id, kind: 'question', text: 'Hold on' });
    const lines = t.brief('s1');
    expect(lines[1]).toBe('Role: worker, no step claimed.');
    expect(lines.slice(-4)).toEqual([
      `Ready to claim: #${t.ready1.id} Ready one · #${t.ready2.id} Ready two · #${t.ready3.id} Ready three`,
      `Claim one: ${CLAIM} s1`,
      'Inheriting a step from a session that handed it to you: add --take-over.',
      expect.stringMatching(/^Other sessions here: B /),
    ].map((x) => x));
    // s2's own queue puts #ready3 first for s2.
    expect(t.brief('s2').find((l) => l.startsWith('Ready to claim:'))).toBe(`Ready to claim: #${t.ready3.id} Ready three · #${t.ready1.id} Ready one · #${t.ready2.id} Ready two`);
    // Neither the asked step nor Aiden's own appears.
    expect(lines.join('\n')).not.toContain('Hold on');
    expect(lines.find((l) => l.startsWith('Ready to claim:'))).not.toContain('Asked');
    expect(lines.find((l) => l.startsWith('Ready to claim:'))).not.toContain('Aiden does');
  });

  it('says nothing is ready, and that planning is the orchestrator job', () => {
    const t = setup();
    t.join('s1');
    const lines = t.brief('s1');
    expect(lines).toContain("Nothing is ready. Planning is the Orchestrator's job (mip-orc).");
    expect(lines.some((l) => l.startsWith('Claim one:'))).toBe(false);
  });
});

describe('orchestrator', () => {
  it('gets its rules, the counts line and today\'s lines after the rules, in either mode', () => {
    for (const mode of ['scoped', 'full'] as const) {
      const t = setup(mode);
      t.join('o1');
      t.ctx.db.prepare("UPDATE sessions SET role = 'orchestrator' WHERE id = 'o1'").run();
      raiseAsk(t.ctx, 'test', { nodeId: t.askedStep.id, kind: 'permission', text: 'Allow it' });
      const lines = renderBriefing(t.snap(), 'o1', Date.parse(t.ctx.now()), { checkOld: true, cli: CLI, counts: 'Since your last look (3d): 4 done.' }).split('\n');
      expect(lines[1]).toBe('Role: orchestrator. You never implement: no code edits, commits, builds or implementers.');
      const rules = lines.find((l) => l.startsWith('- Brief when:'))!;
      expect(rules).toContain('"later: #c, #d" is the unowned order');
      expect(rules).not.toContain('queue:');
      expect(rules).toContain('a step starts ("focus → #id")');
      const counts = lines.indexOf('Since your last look (3d): 4 done.');
      expect(lines[counts + 1]).toBe('Where things stand:');
      expect(lines.some((l) => l.startsWith(`Needs you (1): a1 ⚿ on #${t.askedStep.id} "Allow it"`))).toBe(true);
      expect(lines.some((l) => l.startsWith('Other sessions here') || l.startsWith('Recent resources') || l.startsWith('Needs you'))).toBe(true);
    }
  });
});

describe('status line and status answer', () => {
  it('reads on #id (a7 open) or no step claimed for a scoped worker, with no project count', () => {
    const t = setup();
    t.join('s1');
    const line = () => renderStatusLine(t.snap(), findSession(t.ctx, 's1')!);
    expect(line()).toMatch(/^\[InProgress\] InGame · no step claimed · last scribe update \d+ prompts ago\. If a checkpoint happened/);
    claimStep(t.ctx, 'session:s1', 's1', t.step.id);
    expect(line()).toMatch(new RegExp(`^\\[InProgress\\] InGame · on #${t.step.id} · last scribe update`));
    const ask = raiseAsk(t.ctx, 'test', { nodeId: t.step.id, kind: 'question', text: 'Q' });
    expect(line()).toContain(`on #${t.step.id} (a${ask.id} open) ·`);
    expect(line()).not.toContain('need you');
  });

  it('keeps the count of open asks for an orchestrator and for a full project', () => {
    const t = setup();
    t.join('o1');
    t.ctx.db.prepare("UPDATE sessions SET role = 'orchestrator' WHERE id = 'o1'").run();
    raiseAsk(t.ctx, 'test', { nodeId: t.step.id, kind: 'question', text: 'Q' });
    expect(renderStatusLine(t.snap(), findSession(t.ctx, 'o1')!)).toContain('no focus set · 1 need you ·');
    const full = setup('full');
    full.join('s1');
    raiseAsk(full.ctx, 'test', { nodeId: full.step.id, kind: 'question', text: 'Q' });
    expect(renderStatusLine(full.snap(), findSession(full.ctx, 's1')!)).toContain('· 1 need you ·');
  });

  it('answers a scoped worker with its step block or the unclaimed lines, and an orchestrator with today\'s answer', () => {
    const t = setup();
    t.join('s1');
    t.join('o1');
    t.ctx.db.prepare("UPDATE sessions SET role = 'orchestrator' WHERE id = 'o1'").run();
    const answer = (id: string) => renderStatusAnswer(t.snap(), id, Date.parse(t.ctx.now())).split('\n');
    expect(answer('s1')).toEqual(["Nothing is ready. Planning is the Orchestrator's job (mip-orc)."]);
    setFocus(t.ctx, 'session:s1', 's1', t.step.id);
    expect(answer('s1')[0]).toMatch(/^Your step: /);
    expect(answer('o1')[0]).toBe('[InProgress] Where things stand in InGame (live):');
  });
});

describe('the Needs you line', () => {
  it('lists open asks oldest first, then live permission waits', () => {
    const t = setup('full');
    t.join('s1');
    t.join('s2');
    const first = raiseAsk(t.ctx, 'test', { nodeId: t.askedStep.id, kind: 'question', text: 'Which port?' });
    const second = raiseAsk(t.ctx, 'test', { nodeId: t.step.id, kind: 'review', text: 'Look' });
    setFocus(t.ctx, 'scribe:s2', 's2', t.step.id);
    handleHookEvent(t.ctx, 's2', { event: 'permission' });
    const line = t.brief('s1').find((l) => l.startsWith('Needs you'));
    expect(line).toBe(`Needs you (3): a${first.id} ? on #${t.askedStep.id} "Which port?" · a${second.id} ◎ on #${t.step.id} "Look" · B waiting for permission on #${t.step.id} (<1m)`);
  });
});

describe('Up next reads the Board', () => {
  it('leaves an ended-but-unreleased owner\'s entries out of Next, as the window does, and orders owners by slot', () => {
    const t = setup('full');
    t.join('s1');
    t.join('s2');
    t.join('s3');
    // Stored in this order, s3 appears before s2; the Board orders owners by slot.
    setQueue(t.ctx, 'scribe:s3', t.project.slug, [t.ready3.id], { sessionId: 's3' });
    setQueue(t.ctx, 'scribe:s2', t.project.slug, [t.ready2.id], { sessionId: 's2' });
    setQueue(t.ctx, 'scribe:s1', t.project.slug, [t.ready1.id], 'unowned');
    expect(t.brief('s1').find((l) => l.startsWith('Up next'))).toBe(`Up next: B: #${t.ready2.id} · C: #${t.ready3.id} · later: #${t.ready1.id}`);
    // s2 ends without its queue being released (a row edited behind the server's back): its entry is out of Next, not unowned.
    t.ctx.db.prepare("UPDATE sessions SET state = 'ended', ended_at = ? WHERE id = 's2'").run(t.ctx.now());
    expect(t.brief('s1').find((l) => l.startsWith('Up next'))).toBe(`Up next: C: #${t.ready3.id} · later: #${t.ready1.id}`);
  });
});
