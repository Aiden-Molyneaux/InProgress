import { heldActions } from '../src/core/hold';
import type { Ctx } from '../src/server/db/tx';
import { heldLandingAsk, keylessWhy, publishesFolderPackage, runsAlone, type HeldKeys } from '../src/server/lead/hold';
import { checkLanding, realGit, type LandingDeps } from '../src/server/lead/landing';

/** The real git, untracked: computing a test item's keys adds nothing to a test's own count of git calls. */
const PLAIN: LandingDeps = { git: realGit, visibility: async () => false };

/**
 * The keys holdCheck stores with a held item for `command` run in `cwd` on step `stepId`, as its judge computes them: for each
 * command of it the landing check reads, the folder and branch the hold read and the key its check computed (null when the
 * check computed none). As the hold, nothing for a command that takes no key by its words (keylessWhy), one that does not
 * run alone (runsAlone, the hold makes no item for it), or a publish of
 * anything but its folder's package, and no key for an action whose check could not answer. Undefined when no command of it
 * is checked (the hold stores none).
 */
export async function keysAtHold(ctx: Ctx, ref: string, stepId: number, command: string, cwd: string, deps: LandingDeps = PLAIN): Promise<HeldKeys | undefined> {
  let out: HeldKeys | undefined;
  for (const m of heldActions(command, [], cwd)) {
    if (keylessWhy(command, m) !== undefined || !runsAlone(command, m)) continue;
    if (m.action === 'publish' && !publishesFolderPackage(m.segment)) continue;
    const asked = await heldLandingAsk(m, deps);
    if (!('check' in asked)) continue;
    out ??= { folder: asked.folder, branch: asked.read, keys: {} };
    try {
      const ask = { ref, stepId, action: asked.action, folder: asked.folder, ...(asked.branch === undefined ? {} : { branch: asked.branch }), segment: m.segment };
      out.keys[asked.action] = (await checkLanding(ctx, ask, deps, { record: false })).patchId;
    } catch {
      // As the hold: a check that cannot answer leaves the action with no key at all.
    }
  }
  return out;
}
