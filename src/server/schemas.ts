import { z } from 'zod';
import { ASSIGNEES, HOOK_EVENTS, NODE_KINDS, NODE_STATUSES, RESOURCE_KINDS, WORK_STATUSES, type NodeInput } from '../core/types';

const title = z.string().trim().min(1, 'title is empty').max(200);
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
      children: z.array(nodeInput).max(200).optional(),
    })
    .strict(),
);

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const sessionParam = z.object({ id: z.string().min(1).max(100) });
export const searchQuery = z.object({ project: z.string().min(1), q: z.string().min(1).max(200) });

export const createProjectBody = z
  .object({ name: z.string().trim().min(1, 'name is empty').max(120), description: z.string().max(5_000).optional(), playbook: z.string().max(10_000).optional(), slug: z.string().max(60).optional() })
  .strict();
export const updateProjectBody = z
  .object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(5_000).optional(), playbook: z.string().max(10_000).optional(), status: z.enum(['active', 'archived']).optional() })
  .strict();
export const bindingBody = z.object({ path: z.string().trim().min(1).max(500), branchPattern: z.string().trim().max(200).nullish() }).strict();
export const addNodesBody = z.object({ parentId: z.number().int().positive(), after, nodes: z.array(nodeInput).min(1).max(200) }).strict();
export const updateNodeBody = z
  .object({ title: title.optional(), kind: z.enum(NODE_KINDS).optional(), status: z.enum(NODE_STATUSES).optional(), assignee: z.enum(ASSIGNEES).optional(), body: z.string().max(20_000).optional(), outcome: z.string().max(2_000).optional() })
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
    // model. agent-launched: toolUseId, agentId (the launched agent), model (as the launch reported it).
    // task-created / task-updated: agentId (the subagent whose task list it is; none for the main session), taskKey,
    // subject, status, addBlocks, addBlockedBy. Never a prompt, and never a task's description.
    toolUseId: z.string().min(1).max(200).optional(),
    description: z.string().max(200).optional(),
    model: z.string().max(100).optional(),
    taskKey: z.string().min(1).max(100).optional(),
    subject: z.string().max(300).optional(),
    status: z.enum([...WORK_STATUSES, 'deleted']).optional(),
    addBlocks: z.array(z.string().min(1).max(100)).max(100).optional(),
    addBlockedBy: z.array(z.string().min(1).max(100)).max(100).optional(),
  })
  .strict();
export const queueBody = z.object({ nodes: z.array(z.number().int().positive()).max(200) }).strict();
export const tasksBody = z
  .object({
    nodeId: z.number().int().positive(),
    tasks: z.array(z.object({ subject: z.string().trim().min(1, 'subject is empty').max(300), status: z.enum(WORK_STATUSES) }).strict()).max(50),
  })
  .strict();
export const enrollBody = z.object({ project: z.union([z.string().min(1), z.number().int().positive()]), title: z.string().max(300).optional() }).strict();
export const focusBody = z.object({ nodeId: z.number().int().positive().nullable() }).strict();
export const openBody = z.object({ resourceId: z.number().int().positive() }).strict();
export const openUrlBody = z.object({ url: z.string().min(1).max(2048) }).strict();
