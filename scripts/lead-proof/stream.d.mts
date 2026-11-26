export const HELD_TEXT: string;
export interface StreamCall {
  id: string;
  tool: string;
  command: string | null;
  result: string | null;
  isError: boolean;
  denied: boolean;
}
export function parseStream(text: string): StreamCall[];
