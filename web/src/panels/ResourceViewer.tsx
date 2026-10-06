import { useEffect, useRef, useState } from 'react';
import type { Resource } from '../../../src/core/types';
import { api } from '../api';
import { openLink } from '../links';
import { Markdown } from './Markdown';

export function ResourceViewer({ resourceId, onClose }: { resourceId: number; onClose: () => void }) {
  const [resource, setResource] = useState<Resource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.resource(resourceId).then(setResource).catch((e: Error) => setError(e.message));
  }, [resourceId]);
  // Focus the scrollable body, so Home/End and the arrow keys scroll it as soon as the viewer opens. Its tabIndex
  // of 0 lets Tab reach it again after focus moves to the buttons.
  useEffect(() => {
    body.current?.focus();
    return () => window.clearTimeout(toastTimer.current);
  }, []);

  // One timer for all toasts, so an earlier toast's timeout never cuts a later one short.
  const flash = (message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1500);
  };
  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    flash(label);
  };
  const open = async (id: number) => {
    const result = await api.openResource(id);
    if (result === 'reload') window.location.reload();
    else flash(result === 'ok' ? 'Opened' : result);
  };
  // Only web links open. The server accepts nothing else, and this keeps any other scheme away from window.open.
  const link = resource?.url && /^https?:/i.test(resource.url) ? resource.url : null;

  return (
    <div className="ip-viewer" role="dialog" aria-modal="true" aria-label="Resource">
      <header>
        <b>{resource ? `r${resource.id} ${resource.title}` : 'Resource'}</b>
        {resource?.content && <button className="ip-btn" onClick={() => void copy(resource.content!, 'Copied')}>Copy</button>}
        {resource?.path && <button className="ip-btn" onClick={() => void open(resource.id)}>Open file</button>}
        {resource?.path && <button className="ip-btn" onClick={() => void copy(resource.path!, 'Path copied')}>Copy path</button>}
        {link && <button className="ip-btn" onClick={() => void openLink(link)}>Open link</button>}
        <button className="ip-btn" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div ref={body} className="ip-viewer-body" tabIndex={0}>
        {error ? (
          <p className="muted">{error}</p>
        ) : !resource ? (
          <p className="muted">Loading…</p>
        ) : resource.content ? (
          <Markdown text={resource.content} />
        ) : (
          <p className="muted">{resource.path ? `File: ${resource.path}` : resource.url || 'No content'}</p>
        )}
      </div>
      {toast && <div className="ip-toast">{toast}</div>}
    </div>
  );
}
