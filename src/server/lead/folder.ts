import { join } from 'node:path';
import { isUnder } from '../../lib/paths';
import type { Ctx } from '../db/tx';

/** The lead's own folder for a project: `<home>/lead/<slug>`, where its turns run and its thread lives (task 12). */
export const leadFolderOf = (home: string, slug: string): string => join(home, 'lead', slug);

/**
 * Whether `cwd` is a lead's folder or under one (`<home>/lead/...`). The hooks treat these as the lead's: no session is
 * tracked there, no briefing or nudge is given, and the hold and permission hooks say nothing. False with no home set.
 */
export const isLeadFolder = (ctx: Ctx, cwd: string | undefined): boolean => ctx.home !== undefined && !!cwd && isUnder(cwd, join(ctx.home, 'lead'));
