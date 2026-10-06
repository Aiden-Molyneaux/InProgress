import { api } from './api';

/**
 * Opens an http(s) link in the default browser. The InProgress window is an Edge app window, where a plain link opens
 * in Edge; the server hands the link to Windows instead. If the server can't, the link opens here as before.
 */
export async function openLink(url: string): Promise<void> {
  const result = await api.openUrl(url);
  if (result === 'reload') window.location.reload();
  else if (result !== 'ok') window.open(url, '_blank', 'noopener');
}

/** For a container of rendered Markdown: sends clicks on http(s) links to openLink. */
export function onLinkClick(e: { target: EventTarget; defaultPrevented: boolean; button: number; preventDefault: () => void }): void {
  if (e.defaultPrevented || e.button !== 0) return;
  const anchor = (e.target as Element | null)?.closest?.('a');
  const href = anchor?.getAttribute('href');
  if (!anchor || !href || !/^https?:/i.test(href)) return;
  e.preventDefault();
  void openLink(anchor.href);
}
