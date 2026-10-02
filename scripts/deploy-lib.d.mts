type Rename = (from: string, to: string) => void;

export const TREES: string[];
export function renameWithRetry(from: string, to: string, rename?: Rename): void;
export function promote(o: { repo: string; from: string; prev: string; rename?: Rename }): void;
export function swapWithPrev(o: { repo: string; prev: string; rename?: Rename }): void;
export function suitesFor(changed: string[] | null): { smoke: boolean; e2e: boolean };
