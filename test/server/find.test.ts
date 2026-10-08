import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { deleteProject } from '../../src/server/project-lifecycle';
import { addNodes, deleteNode, updateNode } from '../../src/server/repo/nodes';
import { createProject, updateProject } from '../../src/server/repo/projects';
import { findSteps } from '../../src/server/repo/search';
import { makeCtx } from '../helpers';

/** Three projects: an active one, an archived one and a deleted one, each with a signing step. */
function setup() {
  const ctx = makeCtx();
  const here = createProject(ctx, 't', { name: 'InGame' });
  const shelf = createProject(ctx, 't', { name: 'Old Site' });
  const gone = createProject(ctx, 't', { name: 'Gone' });
  const [play, upload] = addNodes(ctx, 't', { parentId: here.rootNodeId, nodes: [{ title: 'Play app signing' }, { title: 'Upload keystore' }] });
  const [shelved] = addNodes(ctx, 't', { parentId: shelf.rootNodeId, nodes: [{ title: 'Signing for the old app' }] });
  const [lost] = addNodes(ctx, 't', { parentId: gone.rootNodeId, nodes: [{ title: 'Signing lost with its project' }] });
  updateProject(ctx, 't', shelf.slug, { status: 'archived' });
  updateProject(ctx, 't', gone.slug, { status: 'archived' });
  deleteProject(ctx, 't', gone.id);
  return { ctx, here, shelf, play, upload, shelved, lost };
}

describe('findSteps', () => {
  it('finds a step by "#id" or "id" in any project not deleted, with its project', () => {
    const { ctx, here, shelf, play, shelved } = setup();
    expect(findSteps(ctx, `#${play.id}`)).toEqual([
      { id: play.id, title: 'Play app signing', status: 'todo', projectId: here.id, projectSlug: here.slug, projectName: 'InGame', projectStatus: 'active' },
    ]);
    expect(findSteps(ctx, ` ${shelved.id} `)).toEqual([expect.objectContaining({ id: shelved.id, projectSlug: shelf.slug, projectStatus: 'archived' })]);
  });

  it("finds nothing at an id that is unknown, deleted, in a deleted project, or too long to be one", () => {
    const { ctx, upload, lost } = setup();
    deleteNode(ctx, 't', upload.id);
    for (const q of ['#99999', `#${upload.id}`, `${lost.id}`, '#0', '#123456789012345678901', '', '   ']) expect(findSteps(ctx, q), q).toEqual([]);
  });

  it('matches every word in a title, in any order and any case, across projects, active ones first', () => {
    const { ctx, play, shelved } = setup();
    expect(findSteps(ctx, 'SIGNING').map((h) => h.id)).toEqual([play.id, shelved.id]);
    expect(findSteps(ctx, 'signing app').map((h) => h.id)).toEqual([play.id, shelved.id]);
    expect(findSteps(ctx, 'old signing').map((h) => h.id)).toEqual([shelved.id]);
    expect(findSteps(ctx, 'signing keystore')).toEqual([]);
  });

  it("lists the open project's steps first within each tier, and keeps the tiers", () => {
    const { ctx, here, shelf, play, shelved } = setup();
    const other = createProject(ctx, 't', { name: 'Other' });
    const [later] = addNodes(ctx, 't', { parentId: other.rootNodeId, nodes: [{ title: 'Signing again' }] });
    const [doneHere] = addNodes(ctx, 't', { parentId: here.rootNodeId, nodes: [{ title: 'Signing done here' }] });
    updateNode(ctx, 't', doneHere.id, { status: 'done' });
    // Recency alone: the newer step of Other leads.
    expect(findSteps(ctx, 'signing').map((h) => h.id)).toEqual([later.id, play.id, doneHere.id, shelved.id]);
    expect(findSteps(ctx, 'signing', here.slug).map((h) => h.id)).toEqual([play.id, later.id, doneHere.id, shelved.id]);
    // An archived project open in the window still lists after the active ones.
    expect(findSteps(ctx, 'signing', shelf.slug).map((h) => h.id)).toEqual([later.id, play.id, doneHere.id, shelved.id]);
    expect(findSteps(ctx, 'signing', 'no-such-project').map((h) => h.id)).toEqual([later.id, play.id, doneHere.id, shelved.id]);
  });

  it('lists open steps before finished ones, then the most recently changed, at most 20', () => {
    const { ctx, here } = setup();
    const many = addNodes(ctx, 't', { parentId: here.rootNodeId, nodes: Array.from({ length: 25 }, (_, i) => ({ title: `Cap step ${i}` })) });
    updateNode(ctx, 't', many[0].id, { status: 'done' });
    updateNode(ctx, 't', many[1].id, { title: 'Cap step 1 renamed' });
    const hits = findSteps(ctx, 'cap step');
    expect(hits).toHaveLength(20);
    expect(hits[0].id).toBe(many[1].id);
    expect(hits.map((h) => h.id)).not.toContain(many[0].id);
  });

  it('treats %, _ and \\ in a word as themselves', () => {
    const { ctx, here } = setup();
    const [pct, path] = addNodes(ctx, 't', { parentId: here.rootNodeId, nodes: [{ title: 'Ship 100% of it' }, { title: 'Read C:\\temp\\log' }] });
    expect(findSteps(ctx, '100%').map((h) => h.id)).toEqual([pct.id]);
    expect(findSteps(ctx, 'C:\\temp').map((h) => h.id)).toEqual([path.id]);
    expect(findSteps(ctx, '\\').map((h) => h.id)).toEqual([path.id]);
    expect(findSteps(ctx, '_')).toEqual([]);
    expect(findSteps(ctx, 'Ship%it')).toEqual([]);
  });
});

describe('GET /api/find', () => {
  it('answers the window without a token, an empty query with nothing, and refuses one over 200 characters', async () => {
    const { ctx, play } = setup();
    const app = buildApp({ ctx, token: 'tok', uiToken: 'ui', version: 'test' });
    const byId = await app.inject({ url: `/api/find?q=${encodeURIComponent(`#${play.id}`)}` });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toEqual([expect.objectContaining({ id: play.id, title: 'Play app signing' })]);
    expect((await app.inject({ url: '/api/find?q=play%20signing' })).json()).toEqual([expect.objectContaining({ id: play.id })]);
    expect((await app.inject({ url: '/api/find?q=signing&here=ingame' })).json()[0]).toMatchObject({ id: play.id });
    expect((await app.inject({ url: '/api/find' })).json()).toEqual([]);
    expect((await app.inject({ url: `/api/find?q=${'x'.repeat(201)}` })).statusCode).toBe(400);
  });
});
