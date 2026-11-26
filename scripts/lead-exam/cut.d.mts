import type Database from 'better-sqlite3';
export const AFTER: Record<string, string>;
export const REOPENED_STATUS: string;
export function countAfter(db: Database.Database, before: string): Record<string, number>;
export function cutAt(db: Database.Database, before: string, askId: number): void;
export function pointFoldersAway(db: Database.Database, projectId: number, dir: string): string[];
