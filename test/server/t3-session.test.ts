import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { addBinding, createProject } from '../../src/server/repo/projects';
import { findSession } from '../../src/server/repo/sessions';
import { makeCtx } from '../helpers';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };
const bound = 'C:/personal/T3Demo';

function setup() {
  const ctx = makeCtx();
  const p = createProject(ctx, 'test', { name: 'T3Demo' });
  addBinding(ctx, 'test', p.slug, bound);
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test' });
  const hook = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/sessions/${id}/hook`, headers: auth, payload });
  return { ctx, hook };
}

describe('the driver on the session row', () => {
  it('stores driver and thread id from a start, and a later prompt without them keeps both', async () => {
    const { ctx, hook } = setup();
    expect((await hook('s1', { event: 'start', cwd: bound, driver: 't3', t3ThreadId: 'mcp:abc' })).statusCode).toBe(200);
    expect(findSession(ctx, 's1')).toMatchObject({ driver: 't3', t3ThreadId: 'mcp:abc' });
    await hook('s1', { event: 'prompt', cwd: bound });
    await hook('s1', { event: 'stop' });
    expect(findSession(ctx, 's1')).toMatchObject({ driver: 't3', t3ThreadId: 'mcp:abc' });
  });

  it("defaults to 'cli' with no thread", async () => {
    const { ctx, hook } = setup();
    await hook('s1', { event: 'start', cwd: bound });
    expect(findSession(ctx, 's1')).toMatchObject({ driver: 'cli', t3ThreadId: null });
  });

  it('gives a second session on the same thread its own row, both carrying the id', async () => {
    const { ctx, hook } = setup();
    await hook('s1', { event: 'start', cwd: bound, driver: 't3', t3ThreadId: 'mcp:abc' });
    await hook('s2', { event: 'start', cwd: bound, driver: 't3', t3ThreadId: 'mcp:abc' });
    expect(findSession(ctx, 's1')?.t3ThreadId).toBe('mcp:abc');
    expect(findSession(ctx, 's2')?.t3ThreadId).toBe('mcp:abc');
    expect(ctx.db.prepare("SELECT count(*) FROM sessions WHERE t3_thread_id = 'mcp:abc'").pluck().get()).toBe(2);
  });

  it('leaves one row for a session that starts twice', async () => {
    const { ctx, hook } = setup();
    await hook('s1', { event: 'start', cwd: bound, driver: 't3', t3ThreadId: 'mcp:abc' });
    await hook('s1', { event: 'start', cwd: bound, driver: 't3', t3ThreadId: 'mcp:abc' });
    expect(ctx.db.prepare("SELECT count(*) FROM sessions WHERE id = 's1'").pluck().get()).toBe(1);
  });

  it('a new driver replaces the stored one', async () => {
    const { ctx, hook } = setup();
    await hook('s1', { event: 'start', cwd: bound, driver: 'desktop' });
    await hook('s1', { event: 'prompt', cwd: bound, driver: 't3', t3ThreadId: 'mcp:xyz' });
    expect(findSession(ctx, 's1')).toMatchObject({ driver: 't3', t3ThreadId: 'mcp:xyz' });
  });
});
