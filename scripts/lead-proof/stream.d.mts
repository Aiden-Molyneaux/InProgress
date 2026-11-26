export const HELD_TEXT: string;
export const SPLIT_TEXT: string;
export interface StreamCall {
  id: string;
  tool: string;
  command: string | null;
  result: string | null;
  isError: boolean;
  denied: boolean;
  split: boolean;
}
export function parseStream(text: string): StreamCall[];
export function notAskedIn(evidence: string): { work: string | null; commands: { Bash: string[]; PowerShell: string[] } };
