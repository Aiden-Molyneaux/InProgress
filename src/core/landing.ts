/** What a landing check judges: the action asked, and what the change touches. */
export const LANDING_ACTIONS = ['merge', 'deploy', 'push', 'publish', 'push-public'] as const;
export type LandingAction = (typeof LANDING_ACTIONS)[number];

/** The default risk list (P3's): always held as Aiden's; a project's playbook adds to it and never replaces it. */
export const DEFAULT_RISK_GLOBS: readonly string[] = ['src/server/db/**', 'src/hooks/**', 'claude/**', 'src/cli/claude-config.ts', 'scripts/deploy*.mjs'];

export interface LandingInput {
  action: LandingAction;
  /** The files the change touches, repo-relative with forward slashes (a rename lists both paths). */
  files: string[];
  /** What a yes is keyed on: `git patch-id` of the change's diff, or for a publish the head's tree; null when there is none. */
  patchId: string | null;
  riskGlobs: readonly string[];
  /** Whether a push's remote is a public place; null when that could not be read (it is then held, never assumed private). */
  publicRemote: boolean | null;
  /** The remote as a push names it (for the line that says it could not be read). */
  remote?: string;
  /** The project's Landing switch. */
  landingOn: boolean;
  /** The step asked about. */
  stepId?: number | null;
  /** Aiden's yeses on record: each covers one action and one patch id, and was given on a step. */
  yeses: { action: string; patchId: string; stepId?: number | null }[];
  /** A reason the caller found in the change's surroundings (a live build that is not behind main); the change is held for it. */
  holdBecause?: string | null;
}

export interface LandingVerdict {
  clear: boolean;
  /** What the session is told: `Clear to land` or `hold: this is Aiden's (<why>)`. */
  text: string;
  /** The reason alone, for the log. */
  why: string;
}

/** The `Risk: <glob>` lines of a playbook, one per line. */
export function playbookRiskGlobs(playbook: string): string[] {
  const globs: string[] = [];
  for (const line of playbook.split(/\r?\n/)) {
    const m = /^\s*Risk:\s*(\S.*?)\s*$/.exec(line);
    if (m) globs.push(m[1]);
  }
  return globs;
}

/** The risk list of a project: the defaults, and any `Risk:` lines of its playbook added to them (a typo cannot drop the defaults). */
export function riskGlobsOf(playbook: string): string[] {
  return [...new Set([...DEFAULT_RISK_GLOBS, ...playbookRiskGlobs(playbook)])];
}

/**
 * A glob as a regular expression: `**` crosses folders, `*` stays inside one, everything else is literal text (so an
 * unbalanced glob cannot throw). Case-insensitive: NTFS folds case, and holding too much is the safe side.
 */
function globToRe(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`, 'i');
}

/** The files that match any glob, in the order given. */
export function filesOnRiskList(files: readonly string[], globs: readonly string[]): string[] {
  const res = globs.map(globToRe);
  return files.filter((f) => res.some((re) => re.test(f)));
}

const held = (why: string): LandingVerdict => ({ clear: false, text: `hold: this is Aiden's (${why})`, why });

/**
 * Whether the change may land without Aiden, in plain code with no model. Publish and a push to a public place are his
 * whatever the change, and a push to a place that could not be read is held too; so is a change that touches the risk list,
 * and any change while Landing is off. His yes clears only the action and the patch id it was given for: the same action
 * on a changed patch holds again, and says so when his yes was given on this step.
 */
export function landingVerdict(input: LandingInput): LandingVerdict {
  const unread = input.action === 'push' && input.publicRemote !== false && input.publicRemote !== true;
  const action: LandingAction = input.action === 'push' && input.publicRemote === true ? 'push-public' : input.action;
  const forAction = input.yeses.filter((y) => y.action === action);
  const yes = input.patchId !== null && forAction.some((y) => y.patchId === input.patchId);

  let why: string | null = null;
  if (action === 'publish' || action === 'push-public') why = `a ${action} goes out in his name`;
  else if (unread) why = `could not tell whether ${input.remote ?? 'the remote'} is public`;
  else if (input.holdBecause) why = input.holdBecause;
  else {
    const risky = filesOnRiskList(input.files, input.riskGlobs);
    if (risky.length > 0) why = `it touches ${risky.slice(0, 2).join(', ')}`;
    else if (!input.landingOn) why = 'Landing is off';
  }
  if (why === null) return { clear: true, text: 'Clear to land', why: 'nothing of his' };
  if (yes) return { clear: true, text: 'Clear to land', why: 'his yes' };
  if (input.stepId != null && forAction.some((y) => y.stepId === input.stepId)) return held('changed since his yes');
  return held(why);
}
