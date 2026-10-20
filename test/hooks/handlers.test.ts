import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../src/core/types';
import { buildHookBody, buildToolHookBody, commandHead, HOOK_NAMES, hookErrorLine, parseHookInput, purposeOf, runHandler, stripPasted, type HookName, type HookOutput } from '../../src/hooks/handlers';
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

  it('posts nothing for the async group on a pre-tool call', () => {
    const response = { backgroundTaskId: 'b2ngazqom', success: true, resumedAgentId: 'a1', task_id: 'b1', task_type: 'local_bash' };
    for (const tool of ['Bash', 'PowerShell', 'Monitor', 'SendMessage', 'TaskStop']) {
      expect(buildToolHookBody('pre-tool', { session_id: 's', tool_name: tool, tool_use_id: 'toolu_x', tool_input: { command: 'ls', to: 'a1' }, tool_response: response }), tool).toBeUndefined();
    }
  });
});

/** Redacted real hook inputs, one per shape (ids, paths and text swapped for neutral values; field names kept). */
const SESSION = 'sess-0001';
const TRANSCRIPT = 'C:\\Users\\test\\.claude\\projects\\C--demo\\sess-0001.jsonl';
const post = (tool_name: string, extra: Record<string, unknown>) =>
  buildToolHookBody('post-tool', { session_id: SESSION, transcript_path: TRANSCRIPT, hook_event_name: 'PostToolUse', tool_name, tool_use_id: 'toolu_01', duration_ms: 130, ...extra });
const bashInput = { command: 'git status --short && git merge --no-ff goto -m "Merge goto"', description: 'Merge goto and deploy', run_in_background: true };
const bashResponse = { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'bc802pkev' };

describe('buildToolHookBody: post-tool, background commands', () => {
  it('posts a Bash call that went to the background as command-started, with a head, not the command', () => {
    const body = post('Bash', { tool_input: bashInput, tool_response: bashResponse });
    expect(body).toEqual({ event: 'command-started', taskId: 'bc802pkev', toolUseId: 'toolu_01', kind: 'shell', description: 'Merge goto and deploy', commandHead: 'git status', durationMs: 130 });
    expect(JSON.stringify(body)).not.toContain('merge --no-ff');
  });

  it('posts nothing for a Bash call with no background id', () => {
    expect(post('Bash', { tool_input: { command: 'ls' }, tool_response: { stdout: 'a\nb', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } })).toBeUndefined();
    expect(post('Bash', { tool_input: { command: 'ls' }, tool_response: 'plain output' })).toBeUndefined();
    expect(post('Bash', { tool_input: { command: 'ls' }, tool_response: { backgroundTaskId: 'B!' } })).toBeUndefined();
  });

  it('reads the id from a string response, as the id line of the text', () => {
    const body = post('Bash', { tool_input: bashInput, tool_response: 'Command running in background with ID: bc802pkev. Output is being written to: C:/x.output' });
    expect(body).toMatchObject({ event: 'command-started', taskId: 'bc802pkev', kind: 'shell' });
  });

  it('reads no id from output that merely contains an ID: line', () => {
    expect(post('Bash', { tool_input: { command: 'cat /etc/os-release' }, tool_response: 'NAME=Ubuntu\nID: ubuntu2204\n' })).toBeUndefined();
  });

  it('posts a Bash call that timed out into the background (no run_in_background in its input)', () => {
    const body = post('Bash', {
      tool_input: { command: 'cd /c/repo && git worktree add -q -b fix-1 path', description: 'Create worktrees' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'bp2lau998', timedOutAfterMs: 120000, backgroundCwdHint: 'Session cwd remains C:\\work\\repo' },
      duration_ms: 139905,
    });
    expect(body).toEqual({ event: 'command-started', taskId: 'bp2lau998', toolUseId: 'toolu_01', kind: 'shell', description: 'Create worktrees', commandHead: 'git worktree add', durationMs: 139905 });
  });

  it("reads PowerShell's response object (no isImage) like Bash's, and a subagent's call carries its agentId", () => {
    const input = { tool_input: { command: '$SP = "C:\\x"; npm test', description: 'Run tsc and vitest', run_in_background: true }, tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'biec0lt3c' } };
    expect(post('PowerShell', input)).toEqual({ event: 'command-started', taskId: 'biec0lt3c', toolUseId: 'toolu_01', kind: 'shell', description: 'Run tsc and vitest', commandHead: 'npm test', durationMs: 130 });
    expect(post('PowerShell', { ...input, agent_id: 'agent-0001', agent_type: 'general-purpose' })).toMatchObject({ taskId: 'biec0lt3c', agentId: 'agent-0001' });
    expect(post('PowerShell', input)).not.toHaveProperty('agentId');
  });

  it("reads a Monitor's id from taskId and its persistent flag from the response, else the input", () => {
    const input = { tool_input: { description: 'suites finishing', timeout_ms: 1800000, command: 'tail -f x.log' }, tool_response: { taskId: 'b9lc1cnpy', timeoutMs: 1800000, persistent: false } };
    expect(post('Monitor', input)).toEqual({ event: 'command-started', taskId: 'b9lc1cnpy', toolUseId: 'toolu_01', kind: 'monitor', persistent: false, description: 'suites finishing', commandHead: 'tail', durationMs: 130 });
    expect(post('Monitor', { ...input, tool_response: { taskId: 'b9lc1cnpy', persistent: true } })).toMatchObject({ persistent: true });
    expect(post('Monitor', { tool_input: { ...input.tool_input, persistent: true }, tool_response: { taskId: 'b9lc1cnpy' } })).toMatchObject({ persistent: true });
    expect(post('Monitor', { ...input, agent_id: 'agent-0001' })).toMatchObject({ agentId: 'agent-0001' });
    expect(post('Monitor', { ...input, tool_response: 'Monitor started (task b9lc1cnpy, timeout 1800000ms).' })).toMatchObject({ taskId: 'b9lc1cnpy', persistent: false });
    expect(post('Monitor', { ...input, tool_response: { timeoutMs: 1 } })).toBeUndefined();
  });

  it('leaves durationMs out when it is absent, negative, not a number or over seven days, and rounds it', () => {
    const ms = (duration_ms: unknown) => post('Bash', { tool_input: bashInput, tool_response: bashResponse, duration_ms });
    expect(ms(undefined)).not.toHaveProperty('durationMs');
    expect(ms(-1)).not.toHaveProperty('durationMs');
    expect(ms('130')).not.toHaveProperty('durationMs');
    expect(ms(604_800_001)).not.toHaveProperty('durationMs');
    expect(ms(604_800_000)).toMatchObject({ durationMs: 604_800_000 });
    expect(ms(12.6)).toMatchObject({ durationMs: 13 });
  });

  it('clips the description to 200 and leaves out a blank one', () => {
    expect(post('Bash', { tool_input: { ...bashInput, description: 'd'.repeat(300) }, tool_response: bashResponse })).toMatchObject({ description: 'd'.repeat(200) });
    expect(post('Bash', { tool_input: { ...bashInput, description: '  ' }, tool_response: bashResponse })).not.toHaveProperty('description');
  });

  it('turns TaskStop on a shell or a monitor into command-ended killed, from the response then the input', () => {
    const stop = (tool_response: unknown, tool_input: unknown = { task_id: 'bocj576fh' }) => post('TaskStop', { tool_input, tool_response, agent_id: 'agent-0001' });
    expect(stop({ message: 'Successfully stopped task: bocj576fh (npm test)', task_id: 'bocj576fh', task_type: 'local_bash', command: 'npm test' })).toEqual({ event: 'command-ended', taskId: 'bocj576fh', outcome: 'killed' });
    expect(stop({ message: 'ok', task_id: 'bm1abcde', task_type: 'monitor' }, { task_id: 'other' })).toEqual({ event: 'command-ended', taskId: 'bm1abcde', outcome: 'killed' });
    expect(stop({ message: 'ok', task_type: 'local_bash' })).toEqual({ event: 'command-ended', taskId: 'bocj576fh', outcome: 'killed' });
  });

  it('turns TaskStop on an agent into agent-ended killed, and posts nothing for a workflow or an unknown type', () => {
    const stop = (task_type: string) => post('TaskStop', { tool_input: { task_id: 'a64d5c5b1' }, tool_response: { message: 'ok', task_id: 'a64d5c5b1', task_type } });
    expect(stop('local_agent')).toEqual({ event: 'agent-ended', agentId: 'a64d5c5b1', reason: 'killed' });
    expect(stop('local_workflow')).toBeUndefined();
    expect(stop('something_new')).toBeUndefined();
    expect(post('TaskStop', { tool_input: {}, tool_response: { task_type: 'local_bash' } })).toBeUndefined();
  });

  it('turns a resumed SendMessage into agent-messaged with its summary and purpose, and never the message', () => {
    const message = 'Calendar fix round. Murr audited the range and found problems.\nSECRET SECOND LINE';
    const body = post('SendMessage', {
      tool_input: { to: 'a64d5c5b1b244eb35', summary: 'Fix the calendar majors', message, type: 'message', recipient: 'a64d5c5b1b244eb35', content: 'Calendar fix round…' },
      tool_response: { success: true, message: 'Resuming agent a64d5c5', resumedAgentId: 'a64d5c5b1b244eb35', pin: { id: 'a64d5c5b1b244eb35', name: 'a64d5c5b1b244eb35', ref: 'a2616e' } },
    });
    expect(body).toEqual({ event: 'agent-messaged', agentId: 'a64d5c5b1b244eb35', resumed: true, summary: 'Fix the calendar majors', purpose: 'Calendar fix round.' });
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(JSON.stringify(body)).not.toContain('audited');
  });

  it('turns a queued SendMessage into resumed false with the id from pin, and falls back to content for the purpose', () => {
    const body = post('SendMessage', {
      tool_input: { to: 'a64d5c5b1b244eb35', summary: 'Owner request', type: 'message', recipient_kind: 'agent', content: 'New owner request. More after that.' },
      tool_response: { success: true, message: 'Message queued for delivery to a64d5c5b1b244eb35 at its next tool round.', pin: { id: 'a64d5c5b1b244eb35', name: 'a64d5c5b1b244eb35', ref: 'a2616e' } },
    });
    expect(body).toEqual({ event: 'agent-messaged', agentId: 'a64d5c5b1b244eb35', resumed: false, summary: 'Owner request', purpose: 'New owner request.' });
  });

  it('posts nothing for a SendMessage a subagent made: it would move a sibling to the main focus', () => {
    const body = {
      tool_input: { to: 'a64d5c5b1b244eb35', summary: 's', message: 'm' },
      tool_response: { success: true, message: 'Resuming agent a64d5c5', resumedAgentId: 'a64d5c5b1b244eb35' },
    };
    expect(post('SendMessage', body)).toMatchObject({ event: 'agent-messaged' });
    expect(post('SendMessage', { ...body, agent_id: 'agent-0001', agent_type: 'general-purpose' })).toBeUndefined();
  });

  it('posts nothing for a SendMessage that failed or names no agent id', () => {
    const tool_input = { to: 'a64d5c5b1b244eb35', summary: 's', message: 'm' };
    expect(post('SendMessage', { tool_input, tool_response: { success: false, message: 'No such agent' } })).toBeUndefined();
    expect(post('SendMessage', { tool_input: { to: 'reviewer', message: 'm' }, tool_response: { success: true, message: 'Delivered to reviewer' } })).toBeUndefined();
    expect(post('SendMessage', { tool_input, tool_response: 'ok' })).toBeUndefined();
  });

  it('leaves the summary and purpose out when the input has none', () => {
    const body = post('SendMessage', { tool_input: { to: 'a1b2c3' }, tool_response: { success: true, resumedAgentId: 'a1b2c3' } });
    expect(body).toEqual({ event: 'agent-messaged', agentId: 'a1b2c3', resumed: true });
  });
});

describe('buildHookBody: prompt-submit task notices', () => {
  const notice = (taskId: string, status: string, extra = '', summary = '') =>
    `<task-notification>\n<task-id>${taskId}</task-id>\n${extra}<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
  const tasks = (prompt: string) => buildHookBody('prompt-submit', { session_id: SESSION, prompt }).tasks;

  it('reads one notice: id, tool use id, status and the exit code from the summary', () => {
    const prompt = notice('bc802pkev', 'completed', '<tool-use-id>toolu_01</tool-use-id>\n', 'Background command "Merge goto" completed (exit code 0)');
    expect(buildHookBody('prompt-submit', { session_id: SESSION, prompt })).toMatchObject({ notice: true, tasks: [{ taskId: 'bc802pkev', toolUseId: 'toolu_01', status: 'completed', exitCode: 0 }] });
  });

  it('reads several notices in order, an exit code 127, and a killed status without an exit code', () => {
    const prompt = [notice('b1abcde', 'failed', '', 'Background command "x" failed with exit code 127'), notice('b2abcde', 'killed', '', 'Background command "y" was stopped'), notice('b3abcde', 'completed')].join('\n');
    expect(tasks(prompt)).toEqual([{ taskId: 'b1abcde', status: 'failed', exitCode: 127 }, { taskId: 'b2abcde', status: 'killed' }, { taskId: 'b3abcde', status: 'completed' }]);
  });

  it('reads notices wrapped in a system reminder, with a negative exit code', () => {
    const prompt = `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n${notice('b1abcde', 'failed', '', 'failed with exit code -1')}\n</system-reminder>`;
    expect(tasks(prompt)).toEqual([{ taskId: 'b1abcde', status: 'failed', exitCode: -1 }]);
  });

  it('skips a malformed block, a block without a task id, and one with an unknown status', () => {
    const prompt = [
      '<task-notification>\n<task-id>b0abcde</task-id>\n<status>completed</status>\n', // no closing tag
      notice('', 'completed'),
      notice('b1abcde', 'running'),
      notice('b2abcde', 'completed'),
    ].join('\n');
    // An unclosed block still has a header, which runs to the next opening tag.
    expect(tasks(prompt)).toEqual([{ taskId: 'b0abcde', status: 'completed' }, { taskId: 'b2abcde', status: 'completed' }]);
  });

  it("reads an agent notice's header, not a task-notification its result quotes", () => {
    const prompt =
      '<task-notification>\n<task-id>a1abcde</task-id>\n<status>completed</status>\n<summary>Agent done</summary>\n<result>Quoting: ' +
      notice('b9zzzzz', 'failed', '', 'failed with exit code 9') +
      '\n<task-id>b8yyyyy</task-id><status>killed</status></result>\n</task-notification>';
    expect(tasks(prompt)).toEqual([{ taskId: 'a1abcde', status: 'completed' }]);
  });

  it('takes the last exit code in the summary', () => {
    expect(tasks(notice('b1abcde', 'failed', '', 'Background command "Retry until exit code 0" failed with exit code 1'))).toEqual([{ taskId: 'b1abcde', status: 'failed', exitCode: 1 }]);
  });

  it('sends at most 20 tasks, and no tasks when none read', () => {
    expect(tasks(Array.from({ length: 25 }, (_, i) => notice(`b${i}x${i}`, 'completed')).join('\n'))).toHaveLength(20);
    expect(buildHookBody('prompt-submit', { session_id: SESSION, prompt: '<task-notification>done</task-notification>' })).not.toHaveProperty('tasks');
  });

  it('sends no tasks for a typed prompt that quotes a notification, and never the prompt text', () => {
    const typed = `Explain this: ${notice('b1abcde', 'completed')}`;
    const body = buildHookBody('prompt-submit', { session_id: SESSION, prompt: typed });
    expect(body).not.toHaveProperty('tasks');
    expect(body).not.toHaveProperty('notice');
    const real = buildHookBody('prompt-submit', { session_id: SESSION, prompt: notice('b1abcde', 'completed', '', 'SECRET SUMMARY') });
    expect(JSON.stringify(real)).not.toContain('SECRET');
  });
});

describe('buildHookBody: stop background tasks', () => {
  const stopBody = (background_tasks?: unknown) =>
    buildHookBody('stop', { session_id: SESSION, transcript_path: TRANSCRIPT, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Waiting.', ...(background_tasks === undefined ? {} : { background_tasks }), session_crons: [] });

  it("sends the session's running tasks with a head for a shell, and never the command", () => {
    const body = stopBody([
      { id: 'sb0o4266c', type: 'monitor', status: 'running', description: 'live updates for the artifact' },
      { id: 'b0vqu2cqu', type: 'shell', status: 'running', description: 'Merge the capture branch', command: 'git status --short && git merge --no-ff hook-capture -m "SECRET MESSAGE"' },
    ]);
    expect(body.background).toEqual([
      { taskId: 'sb0o4266c', type: 'monitor', description: 'live updates for the artifact' },
      { taskId: 'b0vqu2cqu', type: 'shell', description: 'Merge the capture branch', commandHead: 'git status' },
    ]);
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(JSON.stringify(body)).not.toContain('--no-ff');
  });

  it('sends background: [] for an empty array and none when the input has no array', () => {
    expect(stopBody([]).background).toEqual([]);
    expect(stopBody()).not.toHaveProperty('background');
    expect(stopBody('not an array')).not.toHaveProperty('background');
  });

  it('drops entries that are no longer running, and flags a list cut at 50', () => {
    expect(stopBody([{ id: 'b1abcde', type: 'shell', status: 'completed' }, { id: 'b2abcde', type: 'shell', status: 'running' }, { id: 'b3abcde', type: 'shell', status: 'pending' }, { id: 'b4abcde', type: 'shell' }]).background)
      .toEqual([{ taskId: 'b2abcde', type: 'shell' }, { taskId: 'b3abcde', type: 'shell' }, { taskId: 'b4abcde', type: 'shell' }]);
    const running = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i}abcde`, type: 'shell', status: 'running' }));
    const many = stopBody(running(60));
    expect(many.background).toHaveLength(50);
    expect(many.backgroundTruncated).toBe(true);
    expect(stopBody(running(50))).not.toHaveProperty('backgroundTruncated');
    expect(stopBody(running(3))).not.toHaveProperty('backgroundTruncated');
  });

  it('sends at most 50, skips an entry without a string id or a type, and clips type and description', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}abcde`, type: 'shell', status: 'running' }));
    expect(stopBody(many).background).toHaveLength(50);
    expect(stopBody([{ type: 'shell' }, { id: 7, type: 'shell' }, { id: 'b1abcde', type: ' ' }, null, 'x']).background).toEqual([]);
    expect(stopBody([{ id: 'b1abcde', type: 't'.repeat(60), description: 'd'.repeat(300) }]).background).toEqual([{ taskId: 'b1abcde', type: 't'.repeat(40), description: 'd'.repeat(200) }]);
  });

  it('sends stop_hook_active as stopHookActive only when it is a boolean', () => {
    expect(buildHookBody('stop', { session_id: SESSION, stop_hook_active: true }).stopHookActive).toBe(true);
    expect(buildHookBody('stop', { session_id: SESSION, stop_hook_active: false }).stopHookActive).toBe(false);
    expect(buildHookBody('stop', { session_id: SESSION })).not.toHaveProperty('stopHookActive');
    expect(buildHookBody('stop', { session_id: SESSION, stop_hook_active: 'yes' })).not.toHaveProperty('stopHookActive');
    expect(buildHookBody('prompt-submit', { session_id: SESSION, stop_hook_active: true })).not.toHaveProperty('stopHookActive');
  });
});

describe('commandHead', () => {
  it.each<[string, string | undefined]>([
    ['cd /c/x && npm run test:e2e 2>&1 | tail -5', 'npm run test:e2e'],
    ["ssh -o BatchMode=yes -i ~/.ssh/k vdxiii@cadapp76dev 'cd /x && ls'", 'ssh vdxiii@cadapp76dev'],
    ['Set-Location C:\\x; npm test', 'npm test'],
    ["$SP = 'C:\\a;b'; node \"$SP\\run.js\"", 'node'],
    ['FOO=1 BAR=2 npm run build -- --watch', 'npm run build'],
    ['git -C /repo status --short', 'git status'],
    ['pushd /x\nexport A=1; make all', 'make all'],
    ['sl C:\\x && cd y && ls -la', 'ls'],
    ['$env:INPROGRESS_E2E_PORT = 4410; npm run test:e2e', 'npm run test:e2e'],
    ['$env:TOKEN=abc123; npm test', 'npm test'],
    ['${env:X} = 1; npm test', 'npm test'],
    ['cd C:/x && $env:A = 1; npm test', 'npm test'],
    ['CD C:/x; npm test', 'npm test'],
    ['Push-Location C:/x; npm test', 'npm test'],
    ['# build it\nnpm run build', 'npm run build'],
    ['npx tsc --noEmit -p tsconfig.json 2>&1', 'npx tsc'],
    ['git fetch -q origin 2>&1', 'git fetch origin'],
    ['git fetch -q origin main', 'git fetch origin'],
    ['npm install -g typescript', 'npm install typescript'],
    ['A=1 npm test', 'npm test'],
    ['   ', undefined],
    ['cd /x', undefined],
    ['', undefined],
  ])('%j gives %j', (command, head) => {
    expect(commandHead(command)).toBe(head);
  });

  it('carries no secret from a flag or a url', () => {
    for (const command of ['mysql --password hunter2 db', 'curl https://h/x?token=abc', 'mysql -p hunter2 db']) {
      expect(commandHead(command), command).toBeDefined();
      expect(commandHead(command), command).not.toMatch(/hunter2|=abc/);
    }
  });

  it('cuts a long word to 59 characters plus an ellipsis, and keeps three words at most', () => {
    expect(commandHead('x'.repeat(100))).toBe(`${'x'.repeat(59)}…`);
    expect(commandHead('a b c d e')).toBe('a b c');
  });
});

describe('runHandler', () => {
  it('briefs a session started in a bound folder and ignores others', async () => {
    const brief = (await run('session-start', { session_id: 'h1', cwd: `${bound}/src`, source: 'startup', session_title: 'Hook session' }))?.context;
    expect(brief).toContain('tracked in project "HookDemo"');
    expect(brief).toContain('Session id: h1');
    expect(findSession(ctx, 'h1')?.title).toBe('Hook session');
    expect(await run('session-start', { session_id: 'h2', cwd: 'C:/elsewhere', source: 'startup' })).toBeUndefined();
    expect(findSession(ctx, 'h2')).toBeUndefined();
  });

  it('hints untracked sessions only on a direct mention', async () => {
    expect(await run('prompt-submit', { session_id: 'h3', prompt: '<pasted_content>InProgress</pasted_content>' })).toBeUndefined();
    expect((await run('prompt-submit', { session_id: 'h3', prompt: 'track this in InProgress please' }))?.context).toContain('Session id: h3');
  });

  it('answers status questions and updates states', async () => {
    await run('session-start', { session_id: 'h4', cwd: bound, source: 'startup' });
    expect((await run('prompt-submit', { session_id: 'h4', prompt: 'where are we?' }))?.context).toContain('Where things stand in HookDemo');
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
    const got: Record<string, HookOutput | undefined> = {};
    for (const name of HOOK_NAMES) got[name] = await runHandler(name, { session_id: 's' }, stub);
    expect(got).toStrictEqual({
      'session-start': { context: 'x' }, 'prompt-submit': { context: 'x' }, stop: undefined, notification: undefined, 'subagent-start': undefined, 'subagent-stop': undefined, 'session-end': undefined,
      'pre-tool': undefined, 'post-tool': undefined,
    });
    const empty: Parameters<typeof runHandler>[2] = { post: async () => ({ tracked: true, context: '' }), ensureServer: async () => true };
    expect(await runHandler('prompt-submit', { session_id: 's' }, empty)).toBeUndefined();
  });

  it('turns a title demand on the stop reply into a block, and only on stop', async () => {
    const stub: Parameters<typeof runHandler>[2] = { post: async () => ({ tracked: true, title: { title: 'DONE #1 x', reason: '#1 is done' } }), ensureServer: async () => true };
    const stop = await runHandler('stop', { session_id: 's' }, stub);
    expect(stop).toStrictEqual({ block: expect.stringContaining('DONE #1 x') });
    expect(stop?.block).toBe('Set this session\'s title to "DONE #1 x" with mcp__ccd_session_mgmt__set_session_title on "self" (InProgress: #1 is done), then stop.');
    expect(await runHandler('prompt-submit', { session_id: 's' }, stub)).toBeUndefined();
    const both: Parameters<typeof runHandler>[2] = { post: async () => ({ tracked: true, context: 'x', title: { title: 'DONE #1 x', reason: '#1 is done' } }), ensureServer: async () => true };
    expect(await runHandler('prompt-submit', { session_id: 's' }, both)).toStrictEqual({ context: 'x' });
    expect(await runHandler('post-tool', { session_id: 's', tool_name: 'TaskStop', tool_input: { task_id: 'b1abcdef' }, tool_response: { task_id: 'b1abcdef', task_type: 'local_bash' } }, stub)).toBeUndefined();
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
      { agentId: 'ag7', agentType: 'Explore', startedAt: expect.any(String), runStartedAt: expect.any(String), description: `#${step.id} Map the hook payloads`, model: 'haiku', nodeId: step.id, endedAt: null, ordinal: 1, purpose: 'Read the transcripts', endReason: null, lastActiveAt: null },
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

  it('posts every background-work body to the real app, which accepts it (hook and schema agree)', async () => {
    await run('session-start', { session_id: 'h9', cwd: bound, source: 'startup' });
    const sent: unknown[] = [];
    const recording: Parameters<typeof runHandler>[2] = { ensureServer: async () => true, post: async (path, body) => { sent.push(body); return deps.post(path, body); } };
    const toolR = (tool_name: string, tool_input: unknown, tool_response: unknown, extra: Record<string, unknown> = {}) =>
      runHandler('post-tool', { session_id: 'h9', hook_event_name: 'PostToolUse', tool_name, tool_use_id: 'toolu_h9', duration_ms: 90, tool_input, tool_response, ...extra }, recording);
    await toolR('Bash', { command: 'npm test', description: 'Run it', run_in_background: true }, { backgroundTaskId: 'bh9shell1' }, { agent_id: 'agent-h9' });
    await toolR('Monitor', { description: 'watch', command: 'tail -f x' }, { taskId: 'bh9mon001', persistent: true });
    await toolR('TaskStop', { task_id: 'bh9shell1' }, { task_id: 'bh9shell1', task_type: 'local_bash' });
    await toolR('TaskStop', { task_id: 'ah9agent1' }, { task_id: 'ah9agent1', task_type: 'local_agent' });
    await toolR('SendMessage', { to: 'ah9agent1', summary: 'Next', message: 'Do it. Then more.' }, { success: true, resumedAgentId: 'ah9agent1' });
    await runHandler('prompt-submit', { session_id: 'h9', prompt: '<task-notification>\n<task-id>bh9shell1</task-id>\n<status>failed</status>\n<summary>exit code 1</summary>\n</task-notification>' }, recording);
    await runHandler('stop', { session_id: 'h9', background_tasks: [{ id: 'bh9mon001', type: 'monitor', status: 'running', description: 'watch' }, { id: 'bh9shell2', type: 'shell', status: 'running', command: 'npm test -- --watch' }] }, recording);
    expect(sent.map((b) => (b as { event: string }).event)).toEqual(['command-started', 'command-started', 'command-ended', 'agent-ended', 'agent-messaged', 'prompt', 'stop']);
    expect(sent[5]).toMatchObject({ tasks: [{ taskId: 'bh9shell1', status: 'failed', exitCode: 1 }] });
    expect(sent[6]).toMatchObject({ background: [{ taskId: 'bh9mon001', type: 'monitor' }, { taskId: 'bh9shell2', type: 'shell', commandHead: 'npm test' }] });
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
    expect((await run('session-start', { session_id: 'h6', cwd: bound, source: 'startup', session_title: long }))?.context).toContain('tracked in project "HookDemo"');
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
