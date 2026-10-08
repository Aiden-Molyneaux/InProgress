import { z } from 'zod';
import { ASSIGNEES, HOOK_EVENTS, NODE_KINDS, NODE_LABELS, NODE_STATUSES, PROJECT_NAME_MAX, RESOURCE_KINDS, WORK_STATUSES, unknownLabel, type NodeInput } from '../core/types';

const title = z.string().trim().min(1, 'title is empty').max(200);
/** A step's type label; null leaves it unlabelled (or clears it on a patch). */
const label = z.enum(NODE_LABELS, { errorMap: (_issue, ctx) => ({ message: unknownLabel(ctx.data) }) }).nullable().optional();
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
      children: z.array(nodeInput).max(200).optional(),
    })
    .strict(),
);

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const sessionParam = z.object({ id: z.string().min(1).max(100) });
export const searchQuery = z.object({ project: z.string().min(1), q: z.string().min(1).max(200) });
/** The window's Go to field: an id or words, as parseGoTo reads them. Empty answers nothing. */
export const findQuery = z.object({ q: z.string().max(200).default('') });

/** A project's name: trimmed, 1 to 120 characters. */
const projectName = z.string().trim().min(1, 'name is empty').max(PROJECT_NAME_MAX);
export const createProjectBody = z
  .object({ name: projectName, description: z.string().max(5_000).optional(), playbook: z.string().max(10_000).optional(), slug: z.string().max(60).optional() })
  .strict();
export const updateProjectBody = z
  .object({ name: z.string().trim().min(1).max(PROJECT_NAME_MAX).optional(), description: z.string().max(5_000).optional(), playbook: z.string().max(10_000).optional(), status: z.enum(['active', 'archived']).optional() })
  .strict();
export const bindingBody = z.object({ path: z.string().trim().min(1).max(500), branchPattern: z.string().trim().max(200).nullish() }).strict();
export const addNodesBody = z.object({ parentId: z.number().int().positive(), after, nodes: z.array(nodeInput).min(1).max(200) }).strict();
export const updateNodeBody = z
  .object({ title: title.optional(), kind: z.enum(NODE_KINDS).optional(), status: z.enum(NODE_STATUSES).optional(), assignee: z.enum(ASSIGNEES).optional(), body: z.string().max(20_000).optional(), outcome: z.string().max(2_000).optional(), label })
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
  })
  .strict();
export const resourcePatchBody = resourceBody.omit({ sessionId: true }).partial().strict();
export const logBody = z.object({ text: z.string().trim().min(1).max(2_000), sessionId: z.string().max(100).nullish() }).strict();
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
    // Live work (pre-tool and post-tool hooks). agent-dispatch: toolUseId, agentType (subagent_type), description,
    // model, purpose (the prompt's first sentence, clipped to 200). agent-launched: toolUseId, agentId (the launched
    // agent), model (as the launch reported it). task-created / task-updated: agentId (the subagent whose task list it
    // is; none for the main session), taskKey, subject, status, addBlocks, addBlockedBy. Never a whole prompt, and never
    // a task's description.
    toolUseId: z.string().min(1).max(200).optional(),
    description: z.string().max(200).optional(),
    purpose: z.string().max(200).optional(),
    model: z.string().max(100).optional(),
    taskKey: z.string().min(1).max(100).optional(),
    subject: z.string().max(300).optional(),
    status: z.enum([...WORK_STATUSES, 'deleted']).optional(),
    addBlocks: z.array(z.string().min(1).max(100)).max(100).optional(),
    addBlockedBy: z.array(z.string().min(1).max(100)).max(100).optional(),
  })
  .strict();
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
export const openBody = z.object({ resourceId: z.number().int().positive() }).strict();
export const openUrlBody = z.object({ url: z.string().min(1).max(2048) }).strict();
/**
 * A window write on a project by id: the slug it shows, checked against the id (purging the newest project frees its
 * id). Not max 60: a slug made from a 120-character name is longer.
 */
export const windowProjectBody = z.object({ slug: z.string().min(1).max(200) }).strict();
/** The window's rename: the slug it shows, as windowProjectBody, and the new name under the project name rule. */
export const windowRenameBody = z.object({ slug: windowProjectBody.shape.slug, name: projectName }).strict();
