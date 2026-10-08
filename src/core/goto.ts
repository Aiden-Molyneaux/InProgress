import type { NodeStatus, Project } from './types';

/**
 * What the window's Go to field holds: a step's id (`#77` or `77`, spaces round it allowed), words to look for in step
 * titles, or nothing yet.
 */
export type GoToQuery = { kind: 'id'; id: number } | { kind: 'words'; words: string[] } | { kind: 'empty' };

/** The most words a title search takes: the rest of a longer query is left out. */
export const GOTO_MAX_WORDS = 8;

export function parseGoTo(text: string): GoToQuery {
  const t = text.trim();
  if (!t) return { kind: 'empty' };
  const id = /^#?(\d+)$/.exec(t);
  if (id) return { kind: 'id', id: Number(id[1]) };
  return { kind: 'words', words: t.split(/\s+/).slice(0, GOTO_MAX_WORDS) };
}

/** One step the Go to field found: its id and title, and the project it is in. */
export interface StepHit {
  id: number;
  title: string;
  status: NodeStatus;
  projectId: number;
  projectSlug: string;
  projectName: string;
  projectStatus: Project['status'];
}

/** The most steps one Go to search answers with. */
export const GOTO_LIMIT = 20;
