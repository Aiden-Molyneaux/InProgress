/** The app that runs a session: T3 Code, the Claude desktop app, or a plain terminal. */
export type SessionApp = 'desktop' | 't3' | 'cli';
export const SESSION_APPS = ['desktop', 't3', 'cli'] as const;

/** 't3' when T3CODE_THREAD_ID is set; else 'desktop' when CLAUDE_CODE_ENTRYPOINT is 'claude-desktop'; else 'cli'. */
export function appOf(env: Record<string, string | undefined>): SessionApp {
  if (env.T3CODE_THREAD_ID) return 't3';
  if (env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'desktop';
  return 'cli';
}
