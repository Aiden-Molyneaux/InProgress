import { extname } from 'node:path';
import type { LibraryPage, LibraryPages } from '../core/types';
import { normalizePath } from '../lib/paths';
import type { Ctx } from './db/tx';
import { ApiError } from './errors';
import { readPage } from './pages';
import { listBindings } from './repo/projects';
import { requireResource } from './repo/resources';
import { adopters } from './sync';

/** The Library's Pages list (spec 2026-10-20-library-and-docs-design.md, "Pages"): every `library` page, read live. */

interface Row {
  id: number;
  title: string;
  path: string | null;
  project_id: number;
  slug: string;
  name: string;
}

const extFormat = (path: string): 'markdown' | 'html' | null => {
  const ext = extname(path).toLowerCase();
  return ext === '.md' || ext === '.markdown' ? 'markdown' : ext === '.html' || ext === '.htm' ? 'html' : null;
};

/** Which resources to list: every `library` page, or one project's own `page`s. */
export type PageWhere = { purpose: 'library' } | { purpose: 'page'; projectId: number };

/** The pages `where` names, read live: one row each, with its error when the file cannot be read now. */
export async function listPages(ctx: Ctx, where: PageWhere, who?: Awaited<ReturnType<typeof adopters>>): Promise<LibraryPage[]> {
  const rows = ctx.db
    .prepare(
      `SELECT r.id, r.title, r.path, r.project_id, p.slug, p.name FROM resources r JOIN projects p ON p.id = r.project_id
       WHERE r.purpose = ? AND (? IS NULL OR r.project_id = ?) AND p.deleted_at IS NULL ORDER BY r.project_id, r.id`,
    )
    .all(where.purpose, 'projectId' in where ? where.projectId : null, 'projectId' in where ? where.projectId : null) as Row[];
  const adopting = who ?? (await adopters(ctx));
  return Promise.all(
    rows.map(async (row): Promise<LibraryPage> => {
      const base = { id: row.id, title: row.title, path: row.path ?? '', projectId: row.project_id, projectSlug: row.slug, projectName: row.name };
      try {
        const body = await readPage(ctx, requireResource(ctx, row.id));
        const templates = body.front.templates;
        const adaptedIn: LibraryPage['adaptedIn'] = [];
        // One chip per adopting project (spec "Pages"), opening the first of the page's templates it adopts.
        for (const a of adopting) {
          const template = templates.find((t) => a.adopted.includes(t));
          if (template && !adaptedIn.some((x) => x.slug === a.slug)) adaptedIn.push({ slug: a.slug, name: a.name, template });
        }
        return { ...base, format: body.format, shelf: body.front.shelf, templates, ...(body.fresh ? { fresh: body.fresh.count } : {}), error: null, adaptedIn };
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        return { ...base, format: extFormat(base.path), shelf: 'pages', templates: [], error: err.message, adaptedIn: [] };
      }
    }),
  );
}

export async function libraryPages(ctx: Ctx): Promise<LibraryPages> {
  // One read of the manifests serves both the Adapted in chips and the source project.
  const who = await adopters(ctx);
  const pages = await listPages(ctx, { purpose: 'library' }, who);
  const first = new Map<number, string>();
  for (const b of listBindings(ctx)) if (!first.has(b.projectId)) first.set(b.projectId, normalizePath(b.path).toLowerCase());
  const sources = who.map((w) => normalizePath(w.shipwright).toLowerCase()).filter((s) => s !== '' && s !== '.');
  const source = [...first].find(([, path]) => sources.includes(path));
  return { pages, sourceProjectId: source ? source[0] : null };
}

/** A project's own pages (purpose `page`), read live, for its Docs view. */
export const projectPages = (ctx: Ctx, projectId: number): Promise<LibraryPage[]> => listPages(ctx, { purpose: 'page', projectId });
