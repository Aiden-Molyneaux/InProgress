import { z } from 'zod';
import { SESSION_APPS } from '../core/session-app';
import { LEAD_NAME_MAX } from '../core/lead';
import { ID_MAX } from '../core/notices';
import { ASK_KINDS, ASSIGNEES, BRIEFING_MODES, COMMAND_KINDS, COMMAND_OUTCOMES, HOOK_EVENTS, NODE_KINDS, NODE_LABELS, NODE_STATUSES, ORIGINS, PROJECT_NAME_MAX, RANK_BANDS, RESOURCE_KINDS, RESOURCE_PURPOSES, TITLE_CHANNELS, WHAT_WHY_MAX, WORK_STATUSES, unknownLabel, type NodeInput } from '../core/types';

const title = z.string().trim().min(1, 'title is empty').max(200);
/** A step's type label; null leaves it unlabelled (or clears it on a patch). */
const label = z.enum(NODE_LABELS, { errorMap: (_issue, ctx) => ({ message: unknownLabel(ctx.data) }) }).nullable().optional();
/** Why a step is parked: required to park it (the repo refuses an empty one, naming parked_reason). */
const parkedReason = z.string().trim().max(2_000).optional();
/** Where a parked step's work lives: a branch, worktree or commit. */
const parkedWhere = z.string().trim().max(500).optional();
/** A step's What or Why: written for Aiden, trimmed, at most WHAT_WHY_MAX characters. */
const whatWhy = z.string().trim().max(WHAT_WHY_MAX).optional();
export const after = z.union([z.number().int().positive(), z.literal('start'), z.literal('end')]).optional();

export const nodeInput: z.ZodType<NodeInput> = z.lazy(() =>
  z
    .object({
      title,
      kind: z.enum(NODE_KINDS).optional(),
      status: z.enum(NODE_STATUSES).optional(),
      assignee: z.enum(ASSIGNEES).optional(),
      body: z.string().max(20_000).optional(),
      outcome: z.string().max(2_000).optional(),
      label,
      what: whatWhy,
      why: whatWhy,
      // Never me: a session cannot file a step as Aiden's own (a window add is me whatever it sends).
      origin: z.enum(['asked', 'proposed']).optional(),
      children: z.array(nodeInput).max(200).optional(),
    })
    .strict(),
);

/** A session id as Claude Code issues it: a UUID. The desktop launch passes it to a program, so nothing else gets through. */
export const sessionIdParam = z.object({ id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) });
export const idParam = z.object({ id: z.coerce.number().int().positive() });
/** The window's step routes: a project id and a step id in the path. */
export const windowNodeParams = z.object({ id: idParam.shape.id, node: idParam.shape.id });
export const sessionParam = z.object({ id: z.string().min(1).max(100) });
export const digestQuery = z.object({ since: z.string().datetime().optional(), all: z.enum(['1', 'true']).optional() });
export const usageQuery = z.object({ days: z.coerce.number().int().min(1).max(60).default(7) });
export const searchQuery = z.object({ project: z.string().min(1), q: z.string().min(1).max(200) });
/** The window's Go to field: an id or words, as parseGoTo reads them (empty answers nothing), and the open project's slug. */
export const findQuery = z.object({ q: z.string().max(200).default(''), here: z.string().max(100).optional() });

/** A project's name: trimmed, 1 to 120 characters. */
const projectName = z.string().trim().min(1, 'name is empty').max(PROJECT_NAME_MAX);
export const createProjectBody = z
  .object({ name: projectName, description: z.string().max(5_000).optional(), playbook: z.string().max(10_000).optional(), slug: z.string().max(60).optional() })
  .strict();
export const updateProjectBody = z
  .object({ name: z.string().trim().min(1).max(PROJECT_NAME_MAX).optional(), description: z.string().max(5_000).optional(), playbook: z.string().max(10_000).optional(), status: z.enum(['active', 'archived']).optional(), briefingMode: z.enum(BRIEFING_MODES).optional(), titleChannel: z.enum(TITLE_CHANNELS).optional() })
  .strict();
export const bindingBody = z.object({ path: z.string().trim().min(1).max(500), branchPattern: z.string().trim().max(200).nullish() }).strict();
export const addNodesBody = z.object({ parentId: z.number().int().positive(), after, nodes: z.array(nodeInput).min(1).max(200) }).strict();
export const updateNodeBody = z
  .object({ title: title.optional(), kind: z.enum(NODE_KINDS).optional(), status: z.enum(NODE_STATUSES).optional(), assignee: z.enum(ASSIGNEES).optional(), body: z.string().max(20_000).optional(), outcome: z.string().max(2_000).optional(), label, parkedReason, parkedWhere, what: whatWhy, why: whatWhy, origin: z.enum(ORIGINS).optional() })
  .strict();
export const moveNodeBody = z.object({ parentId: z.number().int().positive(), after }).strict();
export const resourceBody = z
  .object({
    nodeId: z.number().int().positive(),
    kind: z.enum(RESOURCE_KINDS),
    title,
    content: z.string().max(1_000_000).nullish(),
    path: z.string().max(1_000).nullish(),
    url: z.string().url().max(2_000).refine((u) => /^https?:\/\//i.test(u), 'url must start with http:// or https://').nullish(),
    sessionId: z.string().max(100).nullish(),
    purpose: z.enum(RESOURCE_PURPOSES).nullish(),
  })
  .strict();
export const resourcePatchBody = resourceBody.omit({ sessionId: true }).partial().strict();
export const askBody = z
  .object({ kind: z.enum(ASK_KINDS), text: z.string().trim().min(1).max(2000), sessionId: z.string().min(1).max(100).nullish() })
  .strict();
export const clearAskBody = z.object({ answer: z.string().max(2000).optional() }).strict();
export const logBody = z.object({ text: z.string().trim().min(1).max(2_000), sessionId: z.string().max(100).nullish() }).strict();
// Unlike the other bodies, this one strips unknown keys instead of rejecting them: `npm run deploy` promotes the new
// hooks a few seconds before the new server starts, and a strict old server would 400 every hook built with a new field.
export const hookBody = z
  .object({
    event: z.enum(HOOK_EVENTS),
    source: z.string().max(40).optional(),
    cwd: z.string().max(1_000).optional(),
    branch: z.string().max(300).nullish(),
    transcriptPath: z.string().max(1_000).optional(),
    title: z.string().max(300).optional(),
    agentId: z.string().max(200).optional(),
    agentType: z.string().max(200).optional(),
    mentionsInProgress: z.boolean().optional(),
    asksStatus: z.boolean().optional(),
    /** A prompt event that is really a background-task notice: the session works, but nothing was typed. */
    notice: z.boolean().optional(),
    /** A prompt that opens with the relay header: the lead's message, passed on through InProgress, not Aiden typing. */
    relayed: z.boolean().optional(),
    // Live work (pre-tool and post-tool hooks). agent-dispatch: toolUseId, agentType (subagent_type), description,
    // model, purpose (the prompt's first sentence, clipped to 200). agent-launched: toolUseId, agentId (the launched
    // agent), model (as the launch reported it). task-created / task-updated: agentId (the subagent whose task list it
    // is; none for the main session), taskKey, subject, status, addBlocks, addBlockedBy. Never a whole prompt, and never
    // a task's description.
    // Background work. command-started: taskId, toolUseId, kind, persistent (a Monitor), description, commandHead (the
    // command's first words, never the command), durationMs, agentId (the subagent that ran it). command-ended (TaskStop
    // on a command): taskId, outcome. agent-ended (TaskStop on an agent): agentId, reason. agent-messaged (SendMessage):
    // agentId (the target), resumed, summary, purpose. A prompt carries `tasks` (the task-notification blocks of a notice, or of a notice reminder ahead of typed text); a
    // stop carries `background` (the session's running background tasks, also when empty) and, when the list was cut at
    // 50, `backgroundTruncated: true`: such a list must not be reconciled against.
    toolUseId: z.string().min(1).max(200).optional(),
    description: z.string().max(200).optional(),
    purpose: z.string().max(200).optional(),
    model: z.string().max(100).optional(),
    taskKey: z.string().min(1).max(100).optional(),
    subject: z.string().max(300).optional(),
    status: z.enum([...WORK_STATUSES, 'deleted']).optional(),
    addBlocks: z.array(z.string().min(1).max(100)).max(100).optional(),
    addBlockedBy: z.array(z.string().min(1).max(100)).max(100).optional(),
    taskId: z.string().min(1).max(100).optional(),
    kind: z.enum(COMMAND_KINDS).optional(),
    persistent: z.boolean().optional(),
    commandHead: z.string().max(60).optional(),
    durationMs: z.number().int().min(0).max(604_800_000).optional(),
    outcome: z.enum(COMMAND_OUTCOMES).optional(),
    exitCode: z.number().int().optional(),
    reason: z.enum(['killed']).optional(),
    resumed: z.boolean().optional(),
    summary: z.string().max(200).optional(),
    tasks: z
      .array(
        z
          .object({ taskId: z.string().min(1).max(100), toolUseId: z.string().min(1).max(200).optional(), status: z.enum(['completed', 'failed', 'killed']), exitCode: z.number().int().optional() }),
      )
      .max(20)
      .optional(),
    background: z
      .array(z.object({ taskId: z.string().min(1).max(100), type: z.string().min(1).max(40), description: z.string().max(200).optional(), commandHead: z.string().max(60).optional() }))
      .max(50)
      .optional(),
    backgroundTruncated: z.boolean().optional(),
    /** A stop: Claude Code's stop_hook_active, true in the extra pass a block caused. */
    stopHookActive: z.boolean().optional(),
    /** A prompt or a stop from a session in the Claude desktop app (CLAUDE_CODE_ENTRYPOINT), the only place the title channel runs. */
    desktop: z.boolean().optional(),
    /** The app that runs the session; sent by a start, a prompt and a stop when it is not a plain terminal. */
    app: z.enum(SESSION_APPS).optional(),
    /** Under T3 Code, the T3 thread the session runs in (T3CODE_THREAD_ID). */
    t3ThreadId: z.string().min(1).max(ID_MAX).optional(),
  });
/**
 * A set_queue write. With `session` and without `unowned: true` it replaces that session's own entries (a `queue:`);
 * otherwise the unowned ones (a `later:`).
 */
export const queueBody = z
  .object({ nodes: z.array(z.number().int().positive()).max(200), session: z.string().min(1).max(100).optional(), unowned: z.boolean().optional() })
  .strict();
export const tasksBody = z
  .object({
    // Left out, the session's focus is used.
    nodeId: z.number().int().positive().optional(),
    tasks: z.array(z.object({ subject: z.string().trim().min(1, 'subject is empty').max(300), status: z.enum(WORK_STATUSES) }).strict()).max(50),
  })
  .strict();
export const enrollBody = z.object({ project: z.union([z.string().min(1), z.number().int().positive()]), title: z.string().max(300).optional() }).strict();
export const focusBody = z.object({ nodeId: z.number().int().positive().nullable() }).strict();
export const claimBody = z.object({ nodeId: z.number().int().positive(), takeOver: z.boolean().optional() }).strict();
export const orchestrateBody = z.object({ status: z.boolean().optional() }).strict();
export const openBody = z.object({ resourceId: z.number().int().positive() }).strict();
export const openUrlBody = z.object({ url: z.string().min(1).max(2048) }).strict();
/**
 * A window write on a project by id: the slug it shows, checked against the id (purging the newest project frees its
 * id). Not max 60: a slug made from a 120-character name is longer.
 */
export const windowProjectBody = z.object({ slug: z.string().min(1).max(200) }).strict();
/** The window's rename: the slug it shows, as windowProjectBody, and the new name under the project name rule. */
export const windowRenameBody = z.object({ slug: windowProjectBody.shape.slug, name: projectName }).strict();
/** The window's queue change (spec 2.5): one operation, applied to the queue as stored. */
export const windowQueueBody = z
  .object({
    slug: windowProjectBody.shape.slug,
    op: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('move'), node: z.number().int().positive(), before: z.number().int().positive().nullable() }).strict(),
      z.object({ kind: z.literal('remove'), node: z.number().int().positive() }).strict(),
    ]),
  })
  .strict();
/** The window's quick-add: a todo step under `parent`, or the root when null; with band 'soon', at the bottom of Soon. */
export const windowNodeBody = z
  .object({
    slug: windowProjectBody.shape.slug,
    title: z.string().trim().min(1).max(200),
    parent: z.number().int().positive().nullable(),
    band: z.literal('soon').optional(),
    body: z.string().max(20_000).optional(),
  })
  .strict();
/** The window's rank change (ranked Backlog spec section 2): one RankOp, applied to the steps as stored. */
export const windowRankBody = z
  .object({
    slug: windowProjectBody.shape.slug,
    op: z.object({ node: z.number().int().positive(), to: z.enum(['next', ...RANK_BANDS]), before: z.number().int().positive().nullable() }).strict(),
  })
  .strict();
/** The inspector's Label select: one of NODE_LABELS, or null for unlabelled. */
export const windowLabelBody = z.object({ slug: windowProjectBody.shape.slug, label: label.unwrap() }).strict();
/** The inspector's Phase select: the new parent's id, or null for No phase (the root). */
export const windowMoveBody = z.object({ slug: windowProjectBody.shape.slug, parent: z.number().int().positive().nullable() }).strict();
/** The window's clear of an ask; only Answer... sends an answer. */
export const windowClearBody = z.object({ answer: z.string().max(2000).optional() }).strict();
/** The window's Done on a Now box: the slug it shows, an optional outcome, and the live driver it showed (a session id or null). */
export const windowDoneBody = z
  .object({ slug: windowProjectBody.shape.slug, outcome: z.string().max(2_000).optional(), driver: z.string().max(100).nullable() })
  .strict();
/** The window's Park: the slug it shows, why the step is set aside (required; an empty one is refused by the repo), and where its work lives. */
export const windowParkBody = z
  .object({ slug: windowProjectBody.shape.slug, reason: z.string().max(2_000), where: z.string().max(500).optional() })
  .strict();
/** The window's Unpark; toNext also appends the step to the unowned Next. */
export const windowUnparkBody = z.object({ slug: windowProjectBody.shape.slug, toNext: z.boolean().optional() }).strict();
/** The window's measurements (spec 2.6): a name and a little data; keys outside WINDOW_EVENT_KEYS are dropped by the route. */
export const WINDOW_EVENT_KEYS = ['view', 'gapMs', 'marks', 'area', 'action', 'node'] as const;
export const windowEventBody = z
  .object({
    name: z.enum(['view', 'shown', 'first_action', 'backlog_open', 'details_open']),
    projectId: z.number().int().positive().nullable(),
    data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();

/** The Library's Sync routes: a project's slug, and a template path as Shipwright lists it. */
const syncSlug = z.string().min(1).max(200);
export const syncBody = z.object({ force: z.boolean().optional() }).strict();
export const syncStepBody = z.object({ slug: syncSlug }).strict();
export const syncTemplateBody = z.object({ slug: syncSlug, template: z.string().min(1).max(300).regex(/^[\w./-]+$/, 'template is not a template path') }).strict();

/** The lead brief route: with `as` it is a lead's read (and needs the instructions version it holds); without, the window's. */
export const leadBriefQuery = z
  .object({ as: z.string().min(1).max(200).optional(), instructions: z.coerce.number().int().min(0).optional() })
  .strict()
  .refine((q) => q.as === undefined || q.instructions !== undefined, { message: 'instructions: needed with as', path: ['instructions'] });
/** The lead's reads of one step, one document and the intent record: who is asking, and the instructions version it holds. */
export const leadReadQuery = z.object({ as: z.string().trim().min(1).max(200), instructions: z.coerce.number().int().min(0) }).strict();
/** The lead's rules route: who is asking. */
export const leadRulesQuery = z.object({ as: z.string().trim().min(1).max(40) }).strict();
/** The lead marking its brief as read: who it is, the instructions version it holds, and the time of the brief it read. */
export const leadSeenBody = z.object({ as: z.string().min(1).max(200), instructions: z.number().int().min(0), at: z.string().datetime().optional() }).strict();
/** Who sends a lead command, and the instructions version it holds: every command's body has both. */
const leadWho = { as: z.string().min(1).max(200), instructions: z.number().int().min(0) };
const leadId = z.number().int().positive();
/** `lead answer`: Aiden's words, carried as the answer to a question of his. */
export const leadAnswerBody = z.object({ ...leadWho, askId: leadId, aidenWords: z.string().trim().min(1).max(2_000) }).strict();
/** `lead park`: the step, why (optional), and Aiden's words (needed for a step of his). */
export const leadParkBody = z
  .object({ ...leadWho, stepId: leadId, reason: z.string().trim().min(1).max(500).optional(), aidenWords: z.string().trim().min(1).max(2_000).optional() })
  .strict();
/** `lead drop`: the step, why (kept in the lead's log), and Aiden's words (needed for a step of his). */
export const leadDropBody = z
  .object({ ...leadWho, stepId: leadId, reason: z.string().trim().min(1).max(500), aidenWords: z.string().trim().min(1).max(2_000).optional() })
  .strict();
/** `lead promise`: what the lead will do, by when, and on which step (none: the project's root). */
export const leadPromiseBody = z.object({ ...leadWho, text: z.string().trim().min(1).max(500), dueAt: z.string().datetime(), stepId: leadId.optional() }).strict();
/** `lead kept`: the promise kept, with a note for the log. */
export const leadKeptBody = z.object({ ...leadWho, askId: leadId, note: z.string().trim().max(500).optional() }).strict();
/** `lead intent`: the whole intent record, Markdown. */
export const leadIntentBody = z.object({ ...leadWho, intent: z.string().min(1).max(8_000) }).strict();
/** `lead relay`: the step whose session gets the message, and the message. */
export const leadRelayBody = z.object({ ...leadWho, stepId: leadId, message: z.string().trim().min(1).max(4_000) }).strict();
/** The window's change of a project's lead: the slug it shows, and a name (trimmed, 1 to 40 characters) or null for none. */
export const windowLeadBody = z.object({ slug: windowProjectBody.shape.slug, name: z.string().trim().min(1).max(LEAD_NAME_MAX).nullable() }).strict();
