type Rename = (from: string, to: string) => void;
type Build = { sha: string; dirty?: boolean; builtAt: string };

export const TREES: string[];
export function renameWithRetry(from: string, to: string, rename?: Rename): void;
export function promote(o: { repo: string; from: string; prev: string; rename?: Rename }): void;
export function swapWithPrev(o: { repo: string; prev: string; rename?: Rename }): void;
export function suitesFor(changed: string[] | null): { smoke: boolean; e2e: boolean };
export function buildLabel(b: Build | null | undefined): string;
export function restartCheck(live: Build | null, seen: { status: number; text: string } | { error: { name?: string; message?: string; cause?: any } }): string | null;
