/** The hash that opens the parts lab. Read the way `#/p/<slug>` is (useInProgress.ts): nothing in the window links to it, you type it. */
export const LAB_HASH = '#/lab';

/** Whether `hash` (window.location.hash) is the lab's, an exact match. */
export function isLabHash(hash: string): boolean {
  return hash === LAB_HASH;
}
