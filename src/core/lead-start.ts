import { clipLine } from './step-ref';

/** What a started thread's first message holds. Every value is cleaned to one line when it is printed. */
export interface StartHandoff {
  lead: string;
  projectName: string;
  stepId: number;
  stepTitle: string;
  what: string;
  why: string;
  goal: string;
  phase: string;
  /** True when Aiden's words came with the start; false when the lead started it on its own judgment, under his mandate. */
  onAidensWord: boolean;
}

/** A value as one line: control characters become a space, then runs of whitespace (line and paragraph separators too) one space, the ends are trimmed. */
// eslint-disable-next-line no-control-regex
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();

/** The first message of a thread the lead started: claim the step, run it through Sigmund, and what the thread is and is not. */
export function startHandoff(h: StartHandoff): string {
  const lead = oneLine(h.lead);
  const project = oneLine(h.projectName);
  const origin = h.onAidensWord ? "on Aiden's word" : "on the lead's own judgment, under his mandate";
  return [
    `Claim #${h.stepId} ${oneLine(h.stepTitle)}. Run this through Sigmund.`,
    '',
    `Started by ${lead}, the lead for ${project}, ${origin}. This is not Aiden, and it is not a go-ahead to merge, deploy or push.`,
    '',
    `What: ${oneLine(h.what)}`,
    `Why: ${oneLine(h.why)}`,
    '',
    `Project goal: ${oneLine(h.goal)}`,
    `Current phase: ${oneLine(h.phase)}`,
    '',
    'First claim the step as your session briefing says, then follow the briefing.',
  ].join('\n');
}

/** The title of a started thread: `#<id> <title>`, one line, cut to 100 characters. */
export const startTitle = (stepId: number, stepTitle: string): string => clipLine(`#${stepId} ${oneLine(stepTitle)}`, 100);
