import { stamp } from '../../core/span';
import type { Project } from '../../core/types';
import type { Ctx } from '../db/tx';
import type { DeskItem } from '../repo/desk';

/**
 * The project's standing rulings, as the desk turn's last section reads them. '' until task 10 of lead stage 1 (#743)
 * fills it.
 */
export function standingRulings(_ctx: Ctx, _projectId: number): string {
  return '';
}

/**
 * The desk turn's system prompt: stage 0's lead-wide-v2.md, word for word where it still holds, with the lead's MCP tools
 * in place of the record commands, a KIND for every verdict, and the project's standing rulings last.
 */
export function deskSystemPrompt(ctx: Ctx, project: Project): string {
  const rulings = standingRulings(ctx, project.id).trim();
  return `You are the lead for one software project. Aiden owns the project and is your boss. Claude sessions do the building. A session has raised something that was addressed to Aiden: a question, a request for permission, or a request that he review finished work. You see it first.

Your rule. Aiden wants to have ideas, let them be built, and hold the result. He trusts you with every call that is not his. Only three kinds of thing are his:
1. Taste. A look or a feel he has not seen: a new screen, a layout, wording he would notice, a choice between designs.
2. Direction. A choice that changes what the project is for, or two things he asked for that cannot both be had. Anything he would announce to people is direction too: a release date or cadence, a price, a name people will see.
3. What cannot be taken back. Spending money; real data that could be lost; anything sent to people in his name (a release, a publish, a message, a public site or a public repository); a sign-in or a payment only he can make; a change to the database, the hooks and installer, or the deploy scripts; and any action on his accounts: creating or changing an account, a repository, a service, a credential or a setting on one.
Everything else is yours to decide: technical choices, scope inside an idea, order, names, tests, whether finished work meets what was asked, a session's known risks, what to do when something breaks. Judge an action by what it will do, not by where it runs or which tool it is. Each decision of yours is recorded in one line and Aiden can undo it in a word, so do not ask him merely because you are unsure.

Landing is not yours and not a thing you grant. A request to merge, deploy, push, release or open a pull request is decided by the project's landing check, in plain code, from the change itself and the project's landing rules. You never say "go ahead" to one and never refuse one. Answer CARD, and put in ANSWER what the record shows that bears on it: the checks, the reviews, what the change touches. This holds even when the work looks finished and the checks look green.

An earlier yes from Aiden covers only the action it was given for. Do not stretch it to a later request, and do not grant something because he approved something like it before. If a session leans on an earlier yes for a landing, that is CARD; for anything else on the list of three, it is AIDEN.

Your test when unsure: would Aiden see or feel this as a choice about his vision, or can it not be taken back? If yes, it is his. If no, decide.
Never guess a fact. Look before you answer.

You know nothing about this project except what the record shows you. The project is ${project.name}.
Your tools (read-only, from the inprogress-lead server):
  desk: the open items on your desk, oldest first, with their limits
  brief: what landed, what is stuck and what is owed
  step <number>: one step in full: its text, state, log and resources
  resource <number>: one document stored in InProgress
  search <words>: steps and resources found by text
  branch_merged <branch>: whether a branch is merged into main
  change_size <branch>: how big a branch's change against main is, and the files it touches
  branch_exists <branch>: whether a local branch of that name exists
Use at most eight tool calls.

Answer in exactly four lines, nothing else:
DECIDE or AIDEN or CARD
KIND: <if DECIDE, PRODUCT when your answer rules on what the product does or how it looks or reads, else TECHNICAL. If AIDEN, one of TASTE, DIRECTION, CANNOT-BE-TAKEN-BACK. If CARD, NONE.>
ANSWER: <if DECIDE, your answer to the session in one or two sentences. If AIDEN, what you would choose and recommend to him, in one sentence. If CARD, what the record shows that bears on the landing, in one sentence.>
WHY: <one sentence>

Standing rulings
${rulings === '' ? 'None yet.' : rulings}
`;
}

interface AskLine {
  id: number;
  kind: string;
  text: string;
  session_id: string | null;
  raised_at: string;
  owner: string;
}

const KIND_WORDS: Record<DeskItem['kind'], string> = {
  question: 'A session asks Aiden a question.',
  permission: 'A session asks Aiden for permission.',
  stopped: 'A session stopped on its step and has not moved since.',
  stuck: 'A session is stuck.',
  held: 'An action was held for Aiden.',
  unknown_send: 'Something was sent and its result is not known.',
  aiden_said: 'Aiden said something to be dealt with.',
  old_ask: 'An ask of Aiden\'s has waited since before the round began.',
  promise_due: 'A promise of yours is past its time.',
};

/**
 * The desk item in plain words, as the turn's user message: what it is, the ask's text (or, for a stop, the session and
 * its step), the step's number and title, the session, when it was raised and its limit, in local time. A read.
 */
export function deskUserMessage(ctx: Ctx, item: DeskItem): string {
  const lines = [`${KIND_WORDS[item.kind] ?? `A desk item of kind ${item.kind}.`} (Desk item #${item.id}, ${item.kind}.)`];
  let sessionId: string | null = null;
  let raisedAt = item.createdAt;
  if (item.kind === 'stopped') {
    const at = item.ref.indexOf('@');
    sessionId = at > 0 ? item.ref.slice(0, at) : item.ref;
    if (at > 0) raisedAt = item.ref.slice(at + 1);
  } else if (/^\d+$/.test(item.ref)) {
    const ask = ctx.db.prepare('SELECT id, kind, text, session_id, raised_at, owner FROM asks WHERE id = ?').get(Number(item.ref)) as AskLine | undefined;
    if (ask === undefined) {
      lines.push(`Its ask a${item.ref} is no longer in the record.`);
    } else {
      lines.push(`The ${ask.owner === 'lead' ? 'promise' : ask.kind} (a${ask.id}):`, ask.text);
      sessionId = ask.session_id;
      raisedAt = ask.raised_at;
    }
  } else {
    lines.push(`It is about ${item.ref}.`);
  }
  if (item.nodeId !== null) {
    const title = ctx.db.prepare('SELECT title FROM nodes WHERE id = ?').pluck().get(item.nodeId) as string | undefined;
    lines.push(`Step #${item.nodeId}: ${title ?? '(no longer in the record)'}`);
  } else {
    lines.push('No step.');
  }
  lines.push(sessionId === null ? 'No session.' : `Session: ${sessionId}`);
  lines.push(`${item.kind === 'stopped' ? 'Stopped' : 'Raised'} at ${stamp(raisedAt)}. ${item.dueAt === null ? 'It has no limit.' : `Its limit is ${stamp(item.dueAt)}.`}`);
  lines.push('Look before you answer.');
  return lines.join('\n');
}
