import { LEAD_INSTRUCTIONS_VERSION, type LeadSwitch } from '../../core/lead';
import { conflict } from '../errors';
import { write, type Ctx } from '../db/tx';
import { leadSwitches, logLeadEvent } from '../lead';
import { resolveProject } from '../repo/projects';

/** Aiden's words on a switch he moved in the window. */
export const SWITCHED_IN_WINDOW = 'switched in the window';

const nameOf = (s: LeadSwitch): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Turns a switch on or off from the window: the same allow or disallow line the lead's commands write, with the window as
 * the actor and "switched in the window" as Aiden's words (the window is Aiden). The project needs a lead, which the log
 * names. A switch already in the state asked for is refused, as the commands refuse it.
 */
export function windowLeadSwitch(ctx: Ctx, projectId: number, name: LeadSwitch, on: boolean): { text: string } {
  return write(ctx, 'window', (record) => {
    // Read inside the write, so the project cannot change between the check and the log line.
    const project = resolveProject(ctx, projectId);
    if (project.status === 'archived') throw conflict('This project is archived.', 'Unarchive it first.');
    if (project.lead === null || project.lead.trim() === '') throw conflict('This project has no lead.', 'Give it one from its actions first.');
    if (leadSwitches(ctx, project.id)[name].on === on) throw conflict(`${nameOf(name)} is already ${on ? 'on' : 'off'}.`, 'Reload the window.');
    logLeadEvent(ctx, { projectId: project.id, lead: project.lead, instructions: LEAD_INSTRUCTIONS_VERSION, kind: on ? 'allow' : 'disallow', text: name, aidenWords: SWITCHED_IN_WINDOW });
    record({ projectId: project.id, type: 'project.updated', entity: 'project', entityId: project.id, data: { changes: { [name]: on ? 'on' : 'off' } } });
    return { text: `${nameOf(name)} is ${on ? 'on' : 'off'} for ${project.name}.` };
  });
}
