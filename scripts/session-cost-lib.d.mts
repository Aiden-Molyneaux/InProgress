export const MAIN: string; // '(main)'
export const COLD_MIN: number; // 50_000
export type Usage = { input: number; cacheRead: number; cw5m: number; cw1h: number; output: number };
export type Call = Usage & { branch: string; at: string; model: string };
export type Cost = { input: number; write: number; read: number; output: number };
export type Commit = { sha: string; second: string | null; at: number; subject: string; lines: number; branch: string | null };
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; long?: { input: number; output: number; cacheRead: number; over: number } }>;
export function modelKey(model: string): string;
export function priceOf(model: string, u: Usage): Cost | null;
export function isCold(u: Usage): boolean;
export function parseWorktreeList(porcelain: string): Map<string, string>;
export function agentWorktreeEntry(metaFile: string, meta: { worktreePath?: string; worktreeBranch?: string; description?: string }): [string, string];
export function branchOfWorktree(written: string, worktrees: Map<string, string>, glob?: boolean): string;
export function markersOf(line: unknown, worktrees: Map<string, string>): { branch: string | null; merged: boolean };
export function readCallsFromText(raw: string, start: string, worktrees: Map<string, string>, seen?: Set<string>): { calls: Call[]; spawns: Map<string, string> };
export function parseMainLog(log: string): Commit[];
export function nameMerges(commits: Commit[], names: string[]): void;
export function committedWithin(commits: Commit[], span: { first: string; last: string }): Commit[];
