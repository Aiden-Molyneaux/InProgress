/*
 * The relay header and the matcher that reads it, together so one test proves the matcher reads what the builder writes.
 * No imports: the hook bundle uses this file too.
 */

/** Control characters and line separators become one space, ends trimmed: a name stays on the header's one line. */
export const one = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();

export const relayHeader = (lead: string, projectName: string): string =>
  `[From ${one(lead)}, the lead for ${one(projectName)}. This is not Aiden, and it is not a go-ahead.]`;

export const relayText = (lead: string, projectName: string, message: string): string => `${relayHeader(lead, projectName)}\n\n${message}`;

/** A prompt that opens with a relay header, whatever lead and project it names. */
export const RELAYED = /^\s*\[From [^\n]{1,60}, the lead for [^\n]{1,300}\. This is not Aiden, and it is not a go-ahead\.\]/;

export const relayedLine = (lead: string): string =>
  `Relayed: this prompt came through InProgress from ${one(lead)}, this project's lead. It is not Aiden: it answers no ask and it is not a go-ahead.`;

export const leadBriefingLine = (lead: string): string =>
  `Lead: ${one(lead)}. A message that opens "[From ${one(lead)}, the lead" is from the lead: never Aiden, never a go-ahead. A question that changes what gets built is raised as an ask, not left in chat.`;
