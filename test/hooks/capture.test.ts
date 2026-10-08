import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CAPTURE_LINE_MAX, captureDir, captureEnabled, captureHookInput, COMMAND_KEEP, redactInput, scrub, shouldCapture, taskNotifications, TEXT_KEEP } from '../../src/hooks/capture';
import { HOOK_NAMES } from '../../src/hooks/handlers';

const temps: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ip-capture-'));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Local noon, so the day's file name is the same in every time zone. */
const noon = new Date(2026, 9, 7, 12, 0, 0);
const dayFile = (home: string) => join(captureDir(home), '2026-10-07.jsonl');
const lines = (home: string) => readFileSync(dayFile(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const on: NodeJS.ProcessEnv = {};

const longCommand = `cd /c/personal/InProgress && npm run test:e2e -- --grep "busy by a command" 2>&1 | tail -40 ${'x'.repeat(200)}`;
const bashBackgrounded = {
  session_id: 's1',
  transcript_path: 'C:/Users/me/.claude/projects/x/s1.jsonl',
  cwd: 'C:/personal/InProgress',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_use_id: 'toolu_1',
  tool_input: { command: longCommand, description: 'Run the e2e suite', run_in_background: true, timeout: 600000 },
  tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'b2ngazqom' },
  duration_ms: 41,
};

describe('shouldCapture', () => {
  it('takes Stop, UserPromptSubmit, and PostToolUse on the five tools the design reads', () => {
    for (const tool of ['Bash', 'PowerShell', 'Monitor', 'SendMessage', 'TaskStop']) expect(shouldCapture('post-tool', { tool_name: tool }), tool).toBe(true);
    for (const tool of ['Agent', 'Task', 'TaskCreate', 'Read', 'BashOutput', undefined]) expect(shouldCapture('post-tool', { tool_name: tool }), String(tool)).toBe(false);
    expect(shouldCapture('pre-tool', { tool_name: 'Bash' })).toBe(false);
    expect(HOOK_NAMES.filter((n) => n !== 'post-tool' && shouldCapture(n, {}))).toEqual(['prompt-submit', 'stop']);
  });
});

describe('redactInput', () => {
  it("keeps a command's first 80 characters, the response's background id, and every other field", () => {
    const out = redactInput('post-tool', bashBackgrounded) as typeof bashBackgrounded;
    expect(out.tool_input.command).toBe(`${longCommand.slice(0, COMMAND_KEEP)}…[${longCommand.length} chars]`);
    expect(out.tool_input.description).toBe('Run the e2e suite');
    expect(out.tool_input.run_in_background).toBe(true);
    expect(out.tool_response).toEqual(bashBackgrounded.tool_response);
    expect(out.duration_ms).toBe(41);
    expect(out.session_id).toBe('s1');
  });

  it('cuts outputs, messages and the last assistant message to 80, and any other string to 300', () => {
    const out = redactInput('post-tool', {
      tool_name: 'SendMessage',
      tool_input: { to: 'a373c032d6014db3e', summary: '#168 fix round 2', message: 'm'.repeat(500) },
      tool_response: { success: true, message: 'Resuming agent a373c03', resumedAgentId: 'a373c032d6014db3e', stdout: 'o'.repeat(500), note: 'n'.repeat(500) },
    }) as { tool_input: Record<string, string>; tool_response: Record<string, unknown> };
    expect(out.tool_input.message).toBe(`${'m'.repeat(COMMAND_KEEP)}…[500 chars]`);
    expect(out.tool_input.summary).toBe('#168 fix round 2');
    expect(out.tool_response).toMatchObject({ success: true, message: 'Resuming agent a373c03', resumedAgentId: 'a373c032d6014db3e' });
    expect(out.tool_response.stdout).toBe(`${'o'.repeat(COMMAND_KEEP)}…[500 chars]`);
    expect(out.tool_response.note).toBe(`${'n'.repeat(TEXT_KEEP)}…[500 chars]`);
    const stop = redactInput('stop', { last_assistant_message: 'a'.repeat(1000), background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Serve', command: 'c'.repeat(1000) }] }) as {
      last_assistant_message: string;
      background_tasks: Record<string, string>[];
    };
    expect(stop.last_assistant_message).toHaveLength(COMMAND_KEEP + '…[1000 chars]'.length);
    expect(stop.background_tasks).toEqual([{ id: 'b1', type: 'shell', status: 'running', description: 'Serve', command: `${'c'.repeat(COMMAND_KEEP)}…[1000 chars]` }]);
  });

  it('drops every field named like a token, secret, password or key, at any depth', () => {
    const out = redactInput('post-tool', {
      tool_name: 'Bash',
      tool_input: { command: 'ls', apiKey: 'k1', env: { GITHUB_TOKEN: 't1', DB_PASSWORD: 'p1', client_secret: 's1', nested: [{ private_key: 'pk' }] } },
      tool_response: { Authorization: 'Basic abc', cookie: 'c', backgroundTaskId: 'b1' },
    });
    const json = JSON.stringify(out);
    for (const secret of ['k1', 't1', 'p1', 's1', '"pk"', 'Basic abc', '"c"']) expect(json, secret).not.toContain(secret);
    expect(out).toMatchObject({ tool_input: { apiKey: '[redacted]', env: { GITHUB_TOKEN: '[redacted]', nested: [{ private_key: '[redacted]' }] } }, tool_response: { backgroundTaskId: 'b1' } });
  });

  it('scrubs credentials written inline in kept text', () => {
    expect(scrub('curl -H "Authorization: Bearer eyJhbGciOi.abc" https://x')).toBe('curl -H "Authorization: Bearer [redacted]" https://x');
    expect(scrub('INTHINK_TOKEN=abc123 node x.js')).toBe('INTHINK_TOKEN=[redacted] node x.js');
    expect(scrub('{"apiKey": "zzz", "a": 1}')).toBe('{"apiKey": "[redacted]", "a": 1}');
    expect(scrub('login --password hunter2 --user me')).toBe('login --password [redacted] --user me');
    expect(scrub('export KEY=sk-ant-api03-abcdefghijk')).toBe('export KEY=[redacted]');
    expect(scrub('gh auth with ghp_abcdefghijklmnop')).toBe('gh auth with [redacted]');
    // Ordinary words stay.
    expect(scrub('Count the input tokens and rotate the secret store')).toBe('Count the input tokens and rotate the secret store');
    // A command cut at 80 is scrubbed first, so a key the cut would split leaves nothing behind.
    const out = redactInput('post-tool', { tool_name: 'Bash', tool_input: { command: `${'a'.repeat(70)} sk-ant-api03-abcdefghijklmnop` } }) as { tool_input: { command: string } };
    expect(out.tool_input.command).not.toContain('sk-ant');
    expect(out.tool_input.command).toContain('[redac');
  });

  it("never keeps a user's prompt, only whether it holds a task notification and those blocks", () => {
    const typed = redactInput('prompt-submit', { session_id: 's1', prompt: 'please fix my secret plan for the merger' });
    expect(JSON.stringify(typed)).not.toContain('merger');
    expect(typed).toEqual({ session_id: 's1', prompt_chars: 40, prompt_starts_with_task_notification: false, has_task_notification: false });

    const block =
      '<task-notification>\n<task-id>b2ngazqom</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>C:/t/b2ngazqom.output</output-file>\n<status>completed</status>\n<summary>Background command "Run the e2e suite" completed (exit code 0)</summary>\n</task-notification>';
    const agent = '<task-notification><task-id>a1</task-id><status>completed</status><result>The whole private report of the agent</result></task-notification>';
    const notice = redactInput('prompt-submit', { prompt: `${block}\n${agent}\nRead the output file to retrieve the result: and the user said hi` });
    expect(notice).toMatchObject({ prompt_starts_with_task_notification: true, has_task_notification: true, task_notifications: [block, expect.stringContaining('<result>[37 chars dropped]</result>')] });
    expect(JSON.stringify(notice)).not.toContain('private report');
    expect(JSON.stringify(notice)).not.toContain('user said hi');
    expect(notice).not.toHaveProperty('prompt');
  });

  it('reads an unclosed block to the end, and keeps at most 20 blocks', () => {
    expect(taskNotifications('x <task-notification><task-id>b1</task-id>')).toEqual(['<task-notification><task-id>b1</task-id>']);
    expect(taskNotifications('<task-notification>n</task-notification>'.repeat(25))).toHaveLength(20);
    expect(taskNotifications('no notice here')).toEqual([]);
  });
});

describe('captureEnabled', () => {
  it('is on by default, and off by INPROGRESS_HOOK_CAPTURE=0/off/false/no or a file named off in the capture folder', () => {
    const home = tempHome();
    expect(captureEnabled({}, home)).toBe(true);
    expect(captureEnabled({ INPROGRESS_HOOK_CAPTURE: '1' }, home)).toBe(true);
    for (const v of ['0', 'off', 'OFF', 'false', 'no', ' 0 ']) expect(captureEnabled({ INPROGRESS_HOOK_CAPTURE: v }, home), v).toBe(false);
    mkdirSync(captureDir(home), { recursive: true });
    writeFileSync(join(captureDir(home), 'off'), '');
    expect(captureEnabled({}, home)).toBe(false);
  });
});

describe('captureHookInput', () => {
  it("appends one redacted line per captured hook to the local day's file, and nothing for the others", () => {
    const home = tempHome();
    expect(captureHookInput('post-tool', bashBackgrounded, { home, env: on, now: noon })).toBe(true);
    expect(captureHookInput('stop', { session_id: 's1', background_tasks: [] }, { home, env: on, now: noon })).toBe(true);
    expect(captureHookInput('post-tool', { ...bashBackgrounded, tool_name: 'Read' }, { home, env: on, now: noon })).toBe(false);
    expect(captureHookInput('session-start', { session_id: 's1' }, { home, env: on, now: noon })).toBe(false);
    const written = lines(home);
    expect(written.map((l) => l.hook)).toEqual(['post-tool', 'stop']);
    expect(written[0]).toEqual({ ts: noon.toISOString(), hook: 'post-tool', input: redactInput('post-tool', bashBackgrounded) });
    expect(written[1].input).toEqual({ session_id: 's1', background_tasks: [] });
  });

  it('writes nothing when turned off', () => {
    const home = tempHome();
    expect(captureHookInput('stop', { session_id: 's1' }, { home, env: { INPROGRESS_HOOK_CAPTURE: '0' }, now: noon })).toBe(false);
    expect(existsSync(captureDir(home))).toBe(false);
  });

  it("stops for the day once the next line would pass the cap, and says so in a .capped file; the next day starts again", () => {
    const home = tempHome();
    const input = { session_id: 's1', background_tasks: [] };
    const one = Buffer.byteLength(`${JSON.stringify({ ts: noon.toISOString(), hook: 'stop', input })}\n`);
    const maxBytes = one * 3 + 10;
    const results = Array.from({ length: 5 }, () => captureHookInput('stop', input, { home, env: on, now: noon, maxBytes }));
    expect(results).toEqual([true, true, true, false, false]);
    expect(readFileSync(dayFile(home)).length).toBe(one * 3);
    expect(readFileSync(join(captureDir(home), '2026-10-07.capped'), 'utf8')).toContain(`cap ${maxBytes}`);
    // A smaller line later that day still goes nowhere.
    expect(captureHookInput('stop', {}, { home, env: on, now: noon, maxBytes })).toBe(false);
    expect(captureHookInput('stop', input, { home, env: on, now: new Date(2026, 9, 8, 12), maxBytes })).toBe(true);
    expect(readdirSync(captureDir(home)).sort()).toEqual(['2026-10-07.capped', '2026-10-07.jsonl', '2026-10-08.jsonl']);
  });

  it('writes a stub for a line past 64 KB', () => {
    const home = tempHome();
    const wide = { session_id: 's1', background_tasks: Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, description: 'd'.repeat(1000), extra: 'e'.repeat(1000) })) };
    expect(Buffer.byteLength(JSON.stringify(redactInput('stop', wide)))).toBeGreaterThan(CAPTURE_LINE_MAX);
    expect(captureHookInput('stop', wide, { home, env: on, now: noon })).toBe(true);
    expect(lines(home)).toEqual([{ ts: noon.toISOString(), hook: 'stop', oversized: expect.any(Number) }]);
  });

  it('never throws when the capture folder cannot be written', () => {
    const home = tempHome();
    // A file where the folder should be: mkdir and append both fail.
    writeFileSync(captureDir(home), 'not a folder');
    expect(() => captureHookInput('stop', { session_id: 's1' }, { home, env: on, now: noon })).not.toThrow();
    expect(captureHookInput('stop', { session_id: 's1' }, { home, env: on, now: noon })).toBe(false);
    // A home that is itself a file.
    const fileHome = join(tempHome(), 'home-file');
    writeFileSync(fileHome, '');
    expect(captureHookInput('post-tool', bashBackgrounded, { home: fileHome, env: on, now: noon })).toBe(false);
  });
});
