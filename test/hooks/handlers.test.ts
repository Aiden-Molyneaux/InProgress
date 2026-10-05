import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../src/core/types';
import { buildHookBody, buildToolHookBody, HOOK_NAMES, hookErrorLine, parseHookInput, purposeOf, runHandler, stripPasted, type HookName } from '../../src/hooks/handlers';
import { ApiClientError, createClient } from '../../src/lib/client';
import { homeDir } from '../../src/lib/home';
import { buildApp } from '../../src/server/app';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject } from '../../src/server/repo/projects';
import { findSession } from '../../src/server/repo/sessions';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import type { Ctx } from '../../src/server/db/tx';
import { makeCtx } from '../helpers';

let ctx: Ctx;
let close: () => Promise<unknown>;
let deps: Parameters<typeof runHandler>[2];
let steps: TreeNode[];
const bound = 'C:/personal/HookDemo';
const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

beforeAll(async () => {
  ctx = makeCtx();
  const p = createProject(ctx, 'test', { name: 'HookDemo' });
  addBinding(ctx, 'test', p.slug, bound);
  steps = addNodes(ctx, 'test', { parentId: p.rootNodeId, nodes: [{ title: 'Step one', status: 'active' }, { title: 'Run the tests', assignee: 'me' }] });
  const app = buildApp({ ctx, token: 'tok', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const client = createClient({ baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, token: 'tok' });
  deps = { post: (path, body) => client.post(path, body), ensureServer: async () => true };
  close = () => app.close();
});
afterAll(async () => {
  await close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const run = (name: HookName, input: Record<string, unknown>) => runHandler(name, input, deps);

describe('parseHookInput', () => {
  it('ignores a UTF-8 BOM (PowerShell pipes add one) and reads empty input as {}', () => {
    expect(parseHookInput('\uFEFF{"session_id":"s1","cwd":"C:/x"}\r\n')).toEqual({ session_id: 's1', cwd: 'C:/x' });
    expect(parseHookInput('')).toEqual({});
    expect(parseHookInput(' \r\n')).toEqual({});
  });
});

describe('hookErrorLine', () => {
  it('appends a string hint and never throws on odd errors', () => {
    expect(hookErrorLine('stop', new ApiClientError(400, 'Invalid body', 'title: too long'))).toBe('stop: Invalid body (title: too long)');
    // A foreign server's 4xx can carry any JSON as its hint; one with no prototype cannot even become a string.
    expect(hookErrorLine('stop', new ApiClientError(418, 'HTTP 418', Object.create(null) as string))).toBe('stop: HTTP 418');
    expect(hookErrorLine('stop', 'plain text')).toBe('stop: plain text');
    expect(hookErrorLine('stop', null)).toBe('stop: null');
  });
});

describe('buildHookBody', () => {
  it('strips pasted blocks before matching', () => {
    expect(stripPasted('hi <pasted_content id="x">track InProgress</pasted_content> there')).toBe('hi  there');
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt: '<pasted_content a>InProgress spec</pasted_content>' })).toMatchObject({ mentionsInProgress: false });
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt: "What's next?" })).toMatchObject({ asksStatus: true, mentionsInProgress: false });
  });

  it.each<[string, boolean]>([
    ['where are we?', true],
    ['What’s next?', true],
    ["what's the status?", true],
    ['status?', true],
    ['status', true],
    ['  Status ?  ', true],
    ['status check please', true],
    ['run git status', false],
    ['the HTTP status code is 500', false],
    ['update the status field', false],
    ['status??', false],
  ])('treats %j as a status question: %s', (prompt, asks) => {
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt }).asksStatus).toBe(asks);
  });

  it('checks a long whitespace run in linear time', () => {
    const prompt = `status${' '.repeat(50_000)}x`;
    const started = performance.now();
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt }).asksStatus).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('marks background-task notices, which reach UserPromptSubmit like typed prompts', () => {
    const notices = [
      'Another Claude session sent a message:\n<agent-message from="a1">done</agent-message>',
      '<agent-message from="a1">\n[Subagent hand-back] The text below is the final report\n</agent-message>',
      '[Subagent hand-back] The text below is the final report of a subagent',
      '<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>…</task-notification>\n</system-reminder>',
      '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>',
      '  [SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.',
    ];
    for (const prompt of notices) {
      expect(buildHookBody('prompt-submit', { session_id: 's', prompt }), prompt).toMatchObject({ notice: true, mentionsInProgress: false, asksStatus: false });
    }
    for (const prompt of ['where are we?', 'Explain this <task-notification> tag in InProgress']) {
      expect(buildHookBody('prompt-submit', { session_id: 's', prompt }), prompt).not.toHaveProperty('notice');
    }
  });

  it('sends cwd and branch with prompts, as session-start does, so a missed start can self-heal', () => {
    const repo = tempDir('ip-hook-git-');
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/VCAD-978\n');
    const cwd = join(repo, 'src');
    expect(buildHookBody('prompt-submit', { session_id: 's', cwd, prompt: 'hi' })).toMatchObject({ event: 'prompt', cwd, branch: 'feature/VCAD-978' });
    const outside = tempDir('ip-hook-plain-');
    const pick = ({ cwd: c, branch }: Record<string, unknown>) => ({ cwd: c, branch });
    expect(pick(buildHookBody('prompt-submit', { session_id: 's', cwd: outside, prompt: 'hi' }))).toEqual(pick(buildHookBody('session-start', { session_id: 's', cwd: outside })));
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt: 'hi' })).not.toHaveProperty('cwd');
    expect(buildHookBody('stop', { session_id: 's', cwd })).not.toHaveProperty('cwd');
  });

  it('leaves out a folder or branch longer than the server accepts, so the prompt still posts', () => {
    const long = `C:/${'x'.repeat(1_000)}`;
    expect(buildHookBody('prompt-submit', { session_id: 's', cwd: long, prompt: 'hi' })).not.toHaveProperty('cwd');
    const repo = tempDir('ip-hook-git-');
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), `ref: refs/heads/${'b'.repeat(301)}\n`);
    expect(buildHookBody('prompt-submit', { session_id: 's', cwd: repo, prompt: 'hi' })).toMatchObject({ cwd: repo, branch: null });
  });

  it('prefers session_title and falls back to the transcript title', () => {
    const file = join(tempDir('ip-hook-'), 't.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'From transcript' })}\n`);
    expect(buildHookBody('session-start', { session_id: 's', cwd: bound, session_title: 'From hook', transcript_path: file }).title).toBe('From hook');
    expect(buildHookBody('stop', { session_id: 's', transcript_path: file }).title).toBe('From transcript');
  });

  it('omits an empty source so the server treats the start as a startup', () => {
    expect(buildHookBody('session-start', { session_id: 's', source: '' })).not.toHaveProperty('source');
  });
});

describe('purposeOf', () => {
  it('takes the first non-blank line, cut after its first sentence end', () => {
    expect(purposeOf('\n   \n  Review the diff for P6. Then report back.\nSecond line.')).toBe('Review the diff for P6.');
    expect(purposeOf('Is the hook wired? Check it.')).toBe('Is the hook wired?');
    expect(purposeOf('Ship it! Now.')).toBe('Ship it!');
    // A stop not followed by a space or the end (a version, a path) does not end the sentence.
    expect(purposeOf('Bump v1.2 in src/core.ts now. Done.')).toBe('Bump v1.2 in src/core.ts now.');
    expect(purposeOf('Wait... then go')).toBe('Wait...');
  });

  it('splits CRLF lines too', () => {
    expect(purposeOf('\r\n\r\nFind the readers row\r\nThe rest stays here.\r\n')).toBe('Find the readers row');
  });

  it('keeps the whole line when it has no sentence end', () => {
    expect(purposeOf('## Brief: implement P6')).toBe('## Brief: implement P6');
    expect(purposeOf('Read every test file and list the helpers\nThen stop.')).toBe('Read every test file and list the helpers');
  });

  it('clips a first sentence over 200 characters to 199 and an ellipsis', () => {
    const purpose = purposeOf(`${'w'.repeat(250)}. Second sentence.`)!;
    expect(purpose).toBe(`${'w'.repeat(199)}…`);
    expect(purpose.length).toBe(200);
    expect(purposeOf(`${'x'.repeat(199)}. Next.`)).toBe(`${'x'.repeat(199)}.`);
    expect(purposeOf('y'.repeat(201))).toBe(`${'y'.repeat(199)}…`);
  });

  it('returns nothing for a blank prompt', () => {
    expect(purposeOf('')).toBeUndefined();
    expect(purposeOf('  \r\n \t\n')).toBeUndefined();
  });
});

describe('buildToolHookBody: pre-tool (Agent dispatch)', () => {
  const agentCall = (tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ session_id: 's', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input, ...extra });

  it('sends the description (clipped to 200), type and model, and of the prompt only its first sentence as the purpose', () => {
    const prompt = 'Map the hook payloads. SECRET PROMPT TEXT follows.\nMore SECRET lines.';
    const body = buildToolHookBody('pre-tool', agentCall({ description: `#44 ${'d'.repeat(250)}`, prompt, subagent_type: 'Explore', model: 'sonnet', run_in_background: true }));
    expect(body).toEqual({ event: 'agent-dispatch', toolUseId: 'toolu_1', agentType: 'Explore', description: `#44 ${'d'.repeat(196)}`, model: 'sonnet', purpose: 'Map the hook payloads.' });
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it('sends exactly the old body, with no purpose key, for a blank prompt', () => {
    expect(buildToolHookBody('pre-tool', agentCall({ description: 'Look', prompt: ' \r\n\t\n', subagent_type: 'Explore' }))).toStrictEqual({
      event: 'agent-dispatch', toolUseId: 'toolu_1', agentType: 'Explore', description: 'Look',
    });
  });

  it('takes the old Task tool name too, and a missing type as general-purpose', () => {
    expect(buildToolHookBody('pre-tool', { ...agentCall({ description: 'Look', prompt: 'p' }), tool_name: 'Task' })).toEqual({ event: 'agent-dispatch', toolUseId: 'toolu_1', agentType: 'general-purpose', description: 'Look', purpose: 'p' });
  });

  it("posts nothing for the scribe's dispatch, a call without an id, or another tool", () => {
    expect(buildToolHookBody('pre-tool', agentCall({ description: 'InProgress update', prompt: 'p', subagent_type: 'inprogress-scribe' }))).toBeUndefined();
    expect(buildToolHookBody('pre-tool', { session_id: 's', tool_name: 'Agent', tool_input: { description: 'x' } })).toBeUndefined();
    expect(buildToolHookBody('pre-tool', { session_id: 's', tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'ls' } })).toBeUndefined();
    expect(buildToolHookBody('pre-tool', { session_id: 's', tool_name: 'Agent', tool_use_id: 't', tool_input: 'not an object' })).toBeUndefined();
  });

  it('posts nothing for a Task call that does not look like an Agent call (no prompt)', () => {
    expect(buildToolHookBody('pre-tool', { session_id: 's', tool_name: 'Task', tool_use_id: 't', tool_input: { description: 'Something else' } })).toBeUndefined();
  });
});

describe('buildToolHookBody: post-tool', () => {
  const launch = (tool_response: unknown, tool_input: Record<string, unknown> = { description: 'Look', prompt: 'SECRET PROMPT', subagent_type: 'Explore' }) =>
    buildToolHookBody('post-tool', { session_id: 's', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input, tool_response });

  it("reads a background launch's agentId and model from its object, never the prompt", () => {
    const body = launch({ isAsync: true, status: 'async_launched', agentId: 'a4e054ee136564424', description: 'Look', resolvedModel: 'claude-opus-5[1m]', prompt: 'SECRET PROMPT', outputFile: 'C:/x.txt' });
    expect(body).toEqual({ event: 'agent-launched', toolUseId: 'toolu_1', agentId: 'a4e054ee136564424', model: 'opus-5' });
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it("reads a foreground agent's completion the same way", () => {
    const done = { status: 'completed', prompt: 'SECRET', agentId: 'b12', agentType: 'general-purpose', content: [{ type: 'text', text: 'REPORT' }], resolvedModel: 'claude-haiku-4-5-20251001', totalDurationMs: 1 };
    expect(launch(done)).toEqual({ event: 'agent-launched', toolUseId: 'toolu_1', agentId: 'b12', model: 'haiku-4-5' });
  });

  it('reads the agentId from the text form of the response', () => {
    const text = "Async agent launched successfully. (This tool result is internal metadata.)\nagentId: a4e054ee136564424 (internal ID - do not mention to user. Use SendMessage with to: 'a4e054ee136564424' to continue this agent.)";
    expect(launch(text)).toEqual({ event: 'agent-launched', toolUseId: 'toolu_1', agentId: 'a4e054ee136564424' });
    expect(launch([{ type: 'text', text }])).toEqual({ event: 'agent-launched', toolUseId: 'toolu_1', agentId: 'a4e054ee136564424' });
    expect(launch({ content: [{ type: 'text', text }] })).toEqual({ event: 'agent-launched', toolUseId: 'toolu_1', agentId: 'a4e054ee136564424' });
  });

  it("posts nothing without an agentId, or for the scribe's launch", () => {
    expect(launch({ status: 'completed', content: [{ type: 'text', text: 'no id here' }] })).toBeUndefined();
    expect(launch('plain text')).toBeUndefined();
    expect(launch({ agentId: 'a1' }, { description: 'InProgress update', prompt: 'p', subagent_type: 'inprogress-scribe' })).toBeUndefined();
  });

  it("mirrors TaskCreate: the key from the response, the subject clipped to 300, never the task's description", () => {
    const input = { session_id: 's', tool_name: 'TaskCreate', tool_use_id: 't', tool_input: { subject: `#57 ${'s'.repeat(350)}`, description: 'SECRET TASK DESCRIPTION', activeForm: 'Writing' }, tool_response: { task: { id: '3', subject: 'x' } } };
    const body = buildToolHookBody('post-tool', input);
    expect(body).toEqual({ event: 'task-created', taskKey: '3', subject: `#57 ${'s'.repeat(296)}` });
    expect(JSON.stringify(body)).not.toContain('SECRET');
    // Inside a subagent the hook input names the agent: its task list is its own.
    expect(buildToolHookBody('post-tool', { ...input, agent_id: 'a1', agent_type: 'Explore' })).toMatchObject({ taskKey: '3', agentId: 'a1' });
  });

  it("takes TaskCreate's key from the text form, and the subject from the response when the input lacks it", () => {
    expect(buildToolHookBody('post-tool', { session_id: 's', tool_name: 'TaskCreate', tool_input: { subject: 'Write it' }, tool_response: 'Task #4 created successfully: Write it' }))
      .toEqual({ event: 'task-created', taskKey: '4', subject: 'Write it' });
    expect(buildToolHookBody('post-tool', { session_id: 's', tool_name: 'TaskCreate', tool_input: {}, tool_response: { task: { id: 5, subject: 'From the response' } } }))
      .toEqual({ event: 'task-created', taskKey: '5', subject: 'From the response' });
    expect(buildToolHookBody('post-tool', { session_id: 's', tool_name: 'TaskCreate', tool_input: { subject: 'No id' }, tool_response: { ok: true } })).toBeUndefined();
  });

  it("mirrors TaskUpdate's status, subject and blocks, never its description", () => {
    const body = buildToolHookBody('post-tool', {
      session_id: 's', tool_name: 'TaskUpdate', tool_use_id: 't',
      tool_input: { taskId: '1', status: 'in_progress', subject: 'Now this', description: 'SECRET', activeForm: 'Doing', addBlocks: ['2'], addBlockedBy: ['3', 4] },
      tool_response: { success: true, taskId: '1', updatedFields: ['status', 'subject', 'description', 'blocks', 'blockedBy'], statusChange: { from: 'pending', to: 'in_progress' } },
    });
    expect(body).toEqual({ event: 'task-updated', taskKey: '1', status: 'in_progress', subject: 'Now this', addBlocks: ['2'], addBlockedBy: ['3', '4'] });
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it('passes deleted, drops a status the server would refuse, and skips a failed or keyless update', () => {
    const update = (tool_input: Record<string, unknown>, tool_response: unknown = { success: true }) => buildToolHookBody('post-tool', { session_id: 's', tool_name: 'TaskUpdate', tool_input, tool_response });
    expect(update({ taskId: '2', status: 'deleted' })).toEqual({ event: 'task-updated', taskKey: '2', status: 'deleted' });
    expect(update({ taskId: 2, status: 'archived' })).toEqual({ event: 'task-updated', taskKey: '2' });
    expect(update({ taskId: '2', status: 'completed' }, { success: false })).toBeUndefined();
    expect(update({ status: 'completed' })).toBeUndefined();
  });

  it('posts nothing for any other tool', () => {
    expect(buildToolHookBody('post-tool', { session_id: 's', tool_name: 'TaskList', tool_input: {}, tool_response: {} })).toBeUndefined();
    expect(buildToolHookBody('post-tool', { session_id: 's' })).toBeUndefined();
  });
});

describe('runHandler', () => {
  it('briefs a session started in a bound folder and ignores others', async () => {
    const brief = await run('session-start', { session_id: 'h1', cwd: `${bound}/src`, source: 'startup', session_title: 'Hook session' });
    expect(brief).toContain('tracked in project "HookDemo"');
    expect(brief).toContain('Session id: h1');
    expect(findSession(ctx, 'h1')?.title).toBe('Hook session');
    expect(await run('session-start', { session_id: 'h2', cwd: 'C:/elsewhere', source: 'startup' })).toBeUndefined();
    expect(findSession(ctx, 'h2')).toBeUndefined();
  });

  it('hints untracked sessions only on a direct mention', async () => {
    expect(await run('prompt-submit', { session_id: 'h3', prompt: '<pasted_content>InProgress</pasted_content>' })).toBeUndefined();
    expect(await run('prompt-submit', { session_id: 'h3', prompt: 'track this in InProgress please' })).toContain('Session id: h3');
  });

  it('answers status questions and updates states', async () => {
    await run('session-start', { session_id: 'h4', cwd: bound, source: 'startup' });
    expect(await run('prompt-submit', { session_id: 'h4', prompt: 'where are we?' })).toContain('Where things stand in HookDemo');
    await run('notification', { session_id: 'h4' });
    expect(findSession(ctx, 'h4')?.state).toBe('permission');
    await run('subagent-start', { session_id: 'h4', agent_id: 'ag1', agent_type: 'Explore' });
    expect(findSession(ctx, 'h4')).toMatchObject({ state: 'working', subagents: [{ agentId: 'ag1', agentType: 'Explore' }] });
    await run('subagent-stop', { session_id: 'h4', agent_id: 'ag1', agent_type: 'Explore' });
    await run('stop', { session_id: 'h4' });
    await run('session-end', { session_id: 'h4' });
    // The stopped subagent's row stays for the trail.
    expect(findSession(ctx, 'h4')).toMatchObject({ state: 'ended', subagents: [{ agentId: 'ag1', endedAt: expect.any(String) }] });
  });

  it('does nothing without a session id', async () => {
    let posted = false;
    const r = await runHandler('stop', {}, { post: async () => { posted = true; return { tracked: false }; }, ensureServer: async () => true });
    expect(r).toBeUndefined();
    expect(posted).toBe(false);
  });

  it('returns context only for events that can inject it', async () => {
    const stub: Parameters<typeof runHandler>[2] = { post: async () => ({ tracked: true, context: 'x' }), ensureServer: async () => true };
    const got: Record<string, string | undefined> = {};
    for (const name of HOOK_NAMES) got[name] = await runHandler(name, { session_id: 's' }, stub);
    expect(got).toStrictEqual({
      'session-start': 'x', 'prompt-submit': 'x', stop: undefined, notification: undefined, 'subagent-start': undefined, 'subagent-stop': undefined, 'session-end': undefined,
      'pre-tool': undefined, 'post-tool': undefined,
    });
  });

  it('pairs a dispatched subagent with its description and node, and stays silent', async () => {
    await run('session-start', { session_id: 'h7', cwd: bound, source: 'startup' });
    const [step] = steps;
    const agentInput = { description: `#${step.id} Map the hook payloads`, prompt: 'Read the transcripts', subagent_type: 'Explore', model: 'haiku' };
    expect(await run('pre-tool', { session_id: 'h7', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_h7', tool_input: agentInput })).toBeUndefined();
    expect(await run('subagent-start', { session_id: 'h7', agent_id: 'ag7', agent_type: 'Explore' })).toBeUndefined();
    const response = { isAsync: true, status: 'async_launched', agentId: 'ag7', resolvedModel: 'claude-haiku-4-5-20251001', prompt: 'Read the transcripts' };
    expect(await run('post-tool', { session_id: 'h7', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_h7', tool_input: agentInput, tool_response: response })).toBeUndefined();
    expect(findSession(ctx, 'h7')!.subagents).toEqual([
      { agentId: 'ag7', agentType: 'Explore', startedAt: expect.any(String), description: `#${step.id} Map the hook payloads`, model: 'haiku', nodeId: step.id, endedAt: null, ordinal: 1, purpose: 'Read the transcripts' },
    ]);
  });

  it('mirrors TaskCreate and TaskUpdate into working tasks, and stays silent', async () => {
    await run('session-start', { session_id: 'h8', cwd: bound, source: 'startup' });
    const [, tests] = steps;
    const create = { session_id: 'h8', tool_name: 'TaskCreate', tool_use_id: 't1', tool_input: { subject: `#${tests.id} Run the suite`, description: 'Full run' }, tool_response: { task: { id: '1', subject: `#${tests.id} Run the suite` } } };
    expect(await run('post-tool', create)).toBeUndefined();
    expect(await run('post-tool', { session_id: 'h8', tool_name: 'TaskUpdate', tool_use_id: 't2', tool_input: { taskId: '1', status: 'in_progress' }, tool_response: { success: true, taskId: '1', updatedFields: ['status'] } })).toBeUndefined();
    const items = getProjectSnapshot(ctx, 'hookdemo').workItems.filter((i) => i.sessionId === 'h8');
    expect(items).toEqual([expect.objectContaining({ nodeId: tests.id, agentId: '', subject: `#${tests.id} Run the suite`, status: 'in_progress' })]);
  });

  it('posts nothing for a tool call it does not mirror', async () => {
    let posted = 0;
    const counting = { post: async () => { posted++; return { tracked: true }; }, ensureServer: async () => true };
    for (const name of ['pre-tool', 'post-tool'] as const) {
      expect(await runHandler(name, { session_id: 's', tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'ls' }, tool_response: {} }, counting)).toBeUndefined();
    }
    expect(posted).toBe(0);
  });

  it('clips a long title to the server limit so the session is still tracked', async () => {
    const long = 'x'.repeat(400);
    expect(await run('session-start', { session_id: 'h6', cwd: bound, source: 'startup', session_title: long })).toContain('tracked in project "HookDemo"');
    expect(buildHookBody('session-start', { session_id: 'h6', cwd: bound, session_title: long }).title).toBe('x'.repeat(300));
    expect(findSession(ctx, 'h6')?.title).toHaveLength(300);
  });
});

describe('runHandler notice diagnostics', () => {
  it('logs the opening of a counted prompt that looks like markup, and nothing for notices or typed prompts', async () => {
    const log = join(homeDir(), 'hooks.log');
    mkdirSync(homeDir(), { recursive: true });
    rmSync(log, { force: true });
    const deps = { ensureServer: async () => true, post: async () => ({ tracked: true }) };
    await runHandler('prompt-submit', { session_id: 's', prompt: '<new-notice-format id="x">done</new-notice-format>' }, deps);
    await runHandler('prompt-submit', { session_id: 's', prompt: '<task-notification>done</task-notification>' }, deps);
    await runHandler('prompt-submit', { session_id: 's', prompt: 'where are we?' }, deps);
    const lines = (existsSync(log) ? readFileSync(log, 'utf8') : '').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('prompt-submit: counted a prompt that opens like markup: "<new-notice-format id=\\"x\\">');
  });
});
