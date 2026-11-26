import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import type { Resource } from '../../src/core/types';
import { buildApp } from '../../src/server/app';
import { readLeadResource, readLeadStep } from '../../src/server/lead-step';
import { addResource, documentsFolder, PICTURE_FILE, requireResource } from '../../src/server/repo/resources';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject, setProjectLead } from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (tag: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `ip-pic-${tag}-`)));
  dirs.push(d);
  return d;
};

/** A home, a repo folder and a T3 Code attachments folder, each with a PNG; a project led by Progresser with one step, and the app on that home. */
function setup() {
  const home = temp('home');
  const repo = temp('repo');
  const attachments = temp('attachments');
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'docs', 'mock.png'), PNG);
  writeFileSync(join(attachments, 'mock.png'), PNG);
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Tabs' }] });
  const app = buildApp({ ctx, home, token: 't', uiToken: 'ui-token', version: 'test' });
  const attach = async (path: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/resources', headers: { authorization: 'Bearer t' }, payload: { nodeId: step.id, kind: 'doc', title: 'The mock', path, ...extra } });
  return { ctx, home, repo, attachments, project, step, attach, folder: documentsFolder(home, project.slug) };
}

describe('a picture has one home', () => {
  it('a PNG from the repo and one from the attachments folder each land in the documents folder, under a free name, and lead step names the copy', async () => {
    const s = setup();
    const a = await s.attach(join(s.repo, 'docs', 'mock.png'), { content: 'bytes read as text' });
    expect(a.statusCode).toBe(201);
    const b = await s.attach(join(s.attachments, 'mock.png'));
    expect(b.statusCode).toBe(201);
    const first = a.json<Resource>();
    const second = b.json<Resource>();
    expect(first.path).toBe(join(s.folder, 'mock.png'));
    expect(second.path).toBe(join(s.folder, 'mock-2.png'));
    expect(readFileSync(second.path!)).toEqual(PNG);
    expect(requireResource(s.ctx, first.id).content).toBeNull();
    expect(PICTURE_FILE.test('C:/x/notes-png')).toBe(false);
    // The originals stay where they were.
    expect(existsSync(join(s.repo, 'docs', 'mock.png'))).toBe(true);
    const step = readLeadStep(s.ctx, s.project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, s.step.id, new Date(s.ctx.now())).text;
    expect(step).toContain(`file ${second.path}`);
    expect(readLeadResource(s.ctx, s.project.slug, 'Progresser', LEAD_INSTRUCTIONS_VERSION, first.id).text).toContain(`Read the file: ${first.path}`);
  });

  it('a picture already in the documents folder stays there; a text file is not copied; rows already stored are not rewritten', async () => {
    const s = setup();
    mkdirSync(s.folder, { recursive: true });
    writeFileSync(join(s.folder, 'here.webp'), PNG);
    const here = (await s.attach(join(s.folder, 'here.webp'))).json<Resource>();
    expect(here.path).toBe(join(s.folder, 'here.webp'));
    expect(existsSync(join(s.folder, 'here-2.webp'))).toBe(false);
    writeFileSync(join(s.repo, 'notes.md'), '# notes');
    const notes = (await s.attach(join(s.repo, 'notes.md'))).json<Resource>();
    expect(notes.path).toBe(join(s.repo, 'notes.md'));
    // Without a home (an old row, or a caller that gives none) nothing is copied.
    const old = addResource(s.ctx, 'test', { nodeId: s.step.id, kind: 'doc', title: 'Old', path: join(s.repo, 'docs', 'mock.png') });
    expect(old.path).toBe(join(s.repo, 'docs', 'mock.png'));
  });

  it('a copy that fails is a 400 with the reason, and nothing is stored', async () => {
    const s = setup();
    const res = await s.attach(join(s.repo, 'missing.png'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Could not copy the picture');
    expect(s.ctx.db.prepare('SELECT COUNT(*) FROM resources').pluck().get()).toBe(0);
  });
});
