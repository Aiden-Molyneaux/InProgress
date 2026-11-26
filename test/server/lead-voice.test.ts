import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { openDb } from '../../src/server/db/connection';
import { createCtx, write, type Ctx } from '../../src/server/db/tx';
import { leadSeen } from '../../src/server/lead-commands';
import { createSender, type SenderT3 } from '../../src/server/lead/sends';
import { createVoiceWebhook, heldVoiceLine, inQuiet, intendHeldLine, VOICE_GATHER_MS, voiceFile, voiceSetUp } from '../../src/server/lead/voice';
import { raiseAsk } from '../../src/server/repo/asks';
import { bringItem } from '../../src/server/repo/deskBring';
import { produceDeskItem } from '../../src/server/repo/deskProducers';
import { insertLeadEvent } from '../../src/server/repo/leadEvents';
import { getSend, intendSend, type LeadSend } from '../../src/server/repo/leadSends';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject, setProjectLead } from '../../src/server/repo/projects';

const V = LEAD_INSTRUCTIONS_VERSION;
const MINUTE = 60 * 1000;
const URL = 'https://voice.example.test/hook/secret-path-123';
const KEY = 'sk-voice-very-secret-key';
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** A T3 Code that is never reached: a voice line never goes there. */
const noT3: SenderT3 = {
  list: async () => [],
  show: async () => {
    throw new Error('not used');
  },
  start: async () => {
    throw new Error('not used');
  },
  send: async () => {
    throw new Error('not used');
  },
};

interface Posted {
  url: string;
  headers: Record<string, string>;
  body: { text: string };
}

/**
 * A project led by Progresser with a question on a step, a temp home (with voice.json unless `setUp` is false), a clock the
 * test moves, quiet hours set away from now, and a fake HTTP client that answers `status` (or throws) and records each POST.
 */
function setup(o: { setUp?: boolean } = {}) {
  let t = Date.parse('2026-11-25T12:00:00.000Z');
  const ctx: Ctx = createCtx(openDb(':memory:'), () => new Date(t).toISOString());
  const advance = (ms: number) => {
    t += ms;
  };
  const home = mkdtempSync(join(tmpdir(), 'ip-voice-'));
  homes.push(home);
  if (o.setUp !== false) {
    mkdirSync(join(home, 'lead'), { recursive: true });
    writeFileSync(voiceFile(home), JSON.stringify({ url: URL, key: KEY }));
  }
  const project = createProject(ctx, 'test', { name: 'InGame' });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Search button' }] });
  // Quiet hours two to three hours from now, local: never now, in any time zone.
  const h = new Date(t).getHours();
  const at = (n: number) => `${String((h + n) % 24).padStart(2, '0')}:00`;
  const setting = (text: string) => write(ctx, 'test', () => insertLeadEvent(ctx.db, { projectId: project.id, lead: 'Progresser', instructions: V, kind: 'setting', text }, ctx.now()));
  setting(`quiet ${at(2)}-${at(3)}`);
  const posts: Posted[] = [];
  let answer: number | Error = 200;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as { text: string } });
    if (answer instanceof Error) throw answer;
    return new Response(answer === 204 ? null : 'ok', { status: answer });
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const sender = createSender(ctx, { t3: noT3, webhook: createVoiceWebhook(ctx, { home, fetch: fakeFetch }) }, { log });
  /** One bring of a new question on the step, as the AIDEN verdict brings it. */
  let n = 0;
  const bring = (wouldHave = 'Search') => {
    const ask = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: `Which name should the button carry, ${++n}?` });
    return write(ctx, 'test', () => {
      const { item } = produceDeskItem(ctx.db, { projectId: project.id, kind: 'question', ref: String(ask.id), nodeId: step.id }, ctx.now());
      return bringItem(ctx, item, { id: null, kind: 'TASTE', answer: wouldHave }, { tell: false })!;
    });
  };
  const lines = (): LeadSend[] => (ctx.db.prepare("SELECT id FROM lead_sends WHERE kind = 'voice_line' ORDER BY id").pluck().all() as number[]).map((id) => getSend(ctx.db, id)!);
  return {
    ctx,
    advance,
    home,
    project,
    step,
    setting,
    posts,
    answer: (a: number | Error) => {
      answer = a;
    },
    logs,
    sender,
    bring,
    lines,
    quietNow: () => setting(`quiet ${at(0)}-${at(1)}`),
  };
}

describe('the Voice: what makes a line', () => {
  it("a bring makes one line in scene 2's shape, keyed by its decision", () => {
    const s = setup();
    const d = s.bring('Search');
    const [line] = s.lines();
    expect(s.lines()).toHaveLength(1);
    expect(line).toMatchObject({ kind: 'voice_line', target: 'webhook', state: 'intended', retryKey: `voice:bring:d${d}` });
    expect(line.body).toBe(
      `Yours, InGame: #${s.step.id} Search button. Which name should the button carry, 1?\nI would pick: Search Say "yes" to that, or give your own answer.`,
    );
  });

  it('a held item makes one line, once per item', () => {
    const s = setup();
    const itemId = write(s.ctx, 'test', () => {
      const { item } = produceDeskItem(s.ctx.db, { projectId: s.project.id, kind: 'held', ref: 'abc', nodeId: s.step.id }, s.ctx.now());
      intendHeldLine(s.ctx.db, { projectId: s.project.id, itemId: item.id, projectName: 'InGame', stepId: s.step.id, what: 'a merge into main' }, s.ctx.now());
      intendHeldLine(s.ctx.db, { projectId: s.project.id, itemId: item.id, projectName: 'InGame', stepId: s.step.id, what: 'a merge into main' }, s.ctx.now());
      return item.id;
    });
    expect(s.lines().map((l) => [l.retryKey, l.body])).toEqual([[`voice:held:${itemId}`, `Held, InGame: #${s.step.id} wants to do a merge into main. Say "go ahead" or "not yet".`]]);
    expect(heldVoiceLine({ projectName: 'InGame', stepId: null, what: 'A deploy' })).toBe('Held, InGame: a session wants to do a deploy. Say "go ahead" or "not yet".');
  });
});

describe('the Voice: gathered, capped, quiet', () => {
  it('gathers for three minutes, then sends every line of the project as one POST with the Bearer key and each [s<id>]', async () => {
    const s = setup();
    s.bring('Search');
    s.advance(MINUTE);
    s.bring('Find');
    s.advance(MINUTE);
    await s.sender.tick();
    expect(s.posts).toHaveLength(0);
    expect(s.lines().every((l) => l.state === 'intended' && l.result === null)).toBe(true);
    s.advance(VOICE_GATHER_MS - 2 * MINUTE);
    await s.sender.tick();
    expect(s.posts).toHaveLength(1);
    const [a, b] = s.lines();
    expect(s.posts[0].url).toBe(URL);
    expect(s.posts[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(s.posts[0].body).toEqual({ text: `${a.body} [s${a.id}]\n\n${b.body} [s${b.id}]` });
    expect(s.lines().map((l) => [l.state, l.result])).toEqual([
      ['done', '200'],
      ['done', '200'],
    ]);
    expect(a.doneAt).toBe(b.doneAt);
    await s.sender.tick();
    expect(s.posts).toHaveLength(1);
  });

  it('a morning line goes at once, and takes the waiting lines with it', async () => {
    const s = setup();
    s.bring();
    write(s.ctx, 'test', () => intendSend(s.ctx.db, { projectId: s.project.id, kind: 'voice_line', target: 'webhook', retryKey: `morning:${s.project.id}:2026-11-25`, body: 'InGame morning list.' }, s.ctx.now()));
    await s.sender.tick();
    expect(s.posts).toHaveLength(1);
    expect(s.lines().every((l) => l.state === 'done')).toBe(true);
  });

  it('holds lines past the day\'s cap, and posts nothing in quiet hours', async () => {
    const s = setup();
    s.setting('voice-cap 1');
    s.bring();
    s.advance(VOICE_GATHER_MS);
    await s.sender.tick();
    expect(s.posts).toHaveLength(1);
    s.bring();
    s.advance(VOICE_GATHER_MS);
    await s.sender.tick();
    expect(s.posts).toHaveLength(1);
    expect(s.lines()[1]).toMatchObject({ state: 'intended', result: null });

    const q = setup();
    q.quietNow();
    q.bring();
    q.advance(VOICE_GATHER_MS);
    await q.sender.tick();
    expect(q.posts).toHaveLength(0);
    expect(q.lines()[0]).toMatchObject({ state: 'intended', result: null });
    expect(inQuiet(23 * 60 + 30, { from: 23 * 60, to: 8 * 60 })).toBe(true);
    expect(inQuiet(8 * 60, { from: 23 * 60, to: 8 * 60 })).toBe(false);
  });
});

describe('the Voice: outcomes', () => {
  it('a 5xx or a network failure leaves every line intended and tried again; a 2xx then sends them once', async () => {
    const s = setup();
    s.bring();
    s.bring();
    s.advance(VOICE_GATHER_MS);
    s.answer(503);
    await s.sender.tick();
    expect(s.lines().map((l) => [l.state, l.result])).toEqual([
      ['intended', null],
      ['intended', null],
    ]);
    s.answer(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    await s.sender.tick();
    expect(s.lines().every((l) => l.state === 'intended' && l.result === null)).toBe(true);
    s.answer(204);
    await s.sender.tick();
    expect(s.posts).toHaveLength(3);
    expect(s.lines().map((l) => [l.state, l.result])).toEqual([
      ['done', '204'],
      ['done', '204'],
    ]);
  });

  it('a 4xx is never sent again: each line is unknown after two looks, with an unknown_send item', async () => {
    const s = setup();
    s.bring();
    s.bring();
    s.advance(VOICE_GATHER_MS);
    s.answer(401);
    await s.sender.tick();
    for (let i = 0; i < 3; i++) {
      s.advance(MINUTE);
      await s.sender.tick();
    }
    expect(s.posts).toHaveLength(1);
    expect(s.lines().map((l) => l.state)).toEqual(['unknown', 'unknown']);
    expect(s.ctx.db.prepare("SELECT ref FROM desk_items WHERE kind = 'unknown_send' ORDER BY id").pluck().all()).toEqual(s.lines().map((l) => String(l.id)));
  });

  it('with no voice.json nothing is sent, nothing fails and nothing is logged; the week says the Voice is not set up', async () => {
    const s = setup({ setUp: false });
    s.bring();
    s.advance(VOICE_GATHER_MS);
    await s.sender.tick();
    expect(s.posts).toHaveLength(0);
    expect(s.lines()[0]).toMatchObject({ state: 'intended', result: null });
    expect(s.logs).toEqual([]);
    expect(voiceSetUp(s.home)).toBe(false);
    expect(voiceSetUp(setup().home)).toBe(true);
  });

  it('never puts the address or the key in a log line or an error', async () => {
    const s = setup();
    s.bring();
    s.advance(VOICE_GATHER_MS);
    s.answer(Object.assign(new Error(`connect failed to ${URL} with ${KEY}`), { cause: { code: 'ENOTFOUND' } }));
    await s.sender.tick();
    s.answer(500);
    await s.sender.tick();
    s.answer(403);
    await s.sender.tick();
    expect(s.logs.length).toBeGreaterThan(0);
    for (const line of s.logs) {
      expect(line).not.toContain(KEY);
      expect(line).not.toContain('voice.example.test');
    }
    expect(s.logs.join('\n')).toContain("the Voice's webhook");
    writeFileSync(voiceFile(s.home), `{ "url": "${URL}", "key": "${KEY}"`);
    s.bring();
    s.advance(VOICE_GATHER_MS);
    await s.sender.tick();
    for (const line of s.logs) expect(line).not.toContain(KEY);
  });

  it('posts to a local receiver over HTTP', async () => {
    const got: { headers: IncomingHttpHeaders; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        got.push({ headers: req.headers, body });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const s = setup();
      writeFileSync(voiceFile(s.home), JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, key: KEY }));
      const webhook = createVoiceWebhook(s.ctx, { home: s.home });
      s.bring();
      s.advance(VOICE_GATHER_MS);
      const [line] = s.lines();
      expect(await webhook(line)).toBe('200');
      expect(got).toHaveLength(1);
      expect(got[0].headers.authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.parse(got[0].body)).toEqual({ text: `${line.body} [s${line.id}]` });
      expect(getSend(s.ctx.db, line.id)).toMatchObject({ state: 'done', result: '200' });
    } finally {
      server.close();
    }
  });
});

describe('lead seen', () => {
  it('stamps a line once; a line of another project, or a send that is not a line, is refused', () => {
    const s = setup();
    s.bring();
    const [line] = s.lines();
    expect(leadSeen(s.ctx, s.project.slug, 'Progresser', V, { sendId: line.id })).toEqual({ text: `Seen s${line.id}.`, stamped: true });
    const first = getSend(s.ctx.db, line.id)!.seenAt;
    expect(first).not.toBeNull();
    s.advance(MINUTE);
    expect(leadSeen(s.ctx, s.project.slug, 'Progresser', V, { sendId: line.id })).toEqual({ text: `Seen s${line.id}.`, stamped: false });
    expect(getSend(s.ctx.db, line.id)!.seenAt).toBe(first);
    const relay = write(s.ctx, 'test', () => intendSend(s.ctx.db, { projectId: s.project.id, kind: 'relay', target: 'th_1', body: 'x' }, s.ctx.now()));
    expect(() => leadSeen(s.ctx, s.project.slug, 'Progresser', V, { sendId: relay.id })).toThrow(expect.objectContaining({ status: 409 }));
    const other = createProject(s.ctx, 'test', { name: 'Other' });
    const theirs = write(s.ctx, 'test', () => intendSend(s.ctx.db, { projectId: other.id, kind: 'voice_line', target: 'webhook', body: 'x' }, s.ctx.now()));
    expect(() => leadSeen(s.ctx, s.project.slug, 'Progresser', V, { sendId: theirs.id })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => leadSeen(s.ctx, s.project.slug, 'Progresser', 6, { sendId: line.id })).toThrow(expect.objectContaining({ status: 409 }));
  });
});
