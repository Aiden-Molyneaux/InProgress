import { useEffect, useRef, useState } from 'react';
import type { Resource } from '../../../src/core/types';
import { api } from '../api';
import { openLink } from '../links';
import { Button } from '../parts/Button';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
import { Toast, ToastRegion } from '../parts/Toast';
import { Markdown } from './Markdown';

/** One line in the viewer's toast region: copy and open results, a failed open in alarm. */
interface Say {
  id: number;
  text: string;
  tone: 'neutral' | 'alarm';
}

export function ResourceViewer({ resourceId, onClose }: { resourceId: number; onClose: () => void }) {
  const [resource, setResource] = useState<Resource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<Say | null>(null);
  const sayId = useRef(0);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.resource(resourceId).then(setResource).catch((e: Error) => setError(e.message));
  }, [resourceId]);
  // Focus the scrollable body, so Home/End and the arrow keys scroll it as soon as the viewer opens. Its tabIndex
  // of 0 lets Tab reach it again after focus moves to the buttons.
  useEffect(() => {
    body.current?.focus();
  }, []);

  // One toast at a time; a new line replaces the old one and restarts its timer (the Toast is keyed per line).
  const say = (text: string, tone: Say['tone'] = 'neutral') => setSaid({ id: ++sayId.current, text, tone });
  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    say(label);
  };
  const open = async (id: number) => {
    const result = await api.openResource(id);
    if (result === 'reload') window.location.reload();
    else if (result === 'ok') say('Opened');
    else say(result, 'alarm');
  };
  // Only web links open. The server accepts nothing else, and this keeps any other scheme away from window.open.
  const link = resource?.url && /^https?:/i.test(resource.url) ? resource.url : null;

  return (
    <div className="ip-viewer" role="dialog" aria-modal="true" aria-label="Resource">
      <header className="ip-vhead">
        <div className="ip-vtitle-block">
          {resource && <Eyebrow>{`R${resource.id} · ${resource.kind.toUpperCase()}`}</Eyebrow>}
          <h2 className="ip-vtitle">{resource ? resource.title : 'Resource'}</h2>
        </div>
        <div className="ip-vact">
          {resource?.content && <Button variant="outline" size="sm" onClick={() => void copy(resource.content!, 'Copied')}>Copy</Button>}
          {resource?.path && <Button variant="outline" size="sm" onClick={() => void open(resource.id)}>Open file</Button>}
          {resource?.path && <Button variant="outline" size="sm" onClick={() => void copy(resource.path!, 'Path copied')}>Copy path</Button>}
          {link && <Button variant="outline" size="sm" onClick={() => void openLink(link)}>Open link</Button>}
          <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}>×</Button>
        </div>
      </header>
      <div ref={body} className="ip-viewer-body" tabIndex={0}>
        <div className="ip-viewer-doc">
          {error ? (
            <ErrorLine message={error} />
          ) : !resource ? (
            <p className="ip-vmuted">Loading…</p>
          ) : resource.content ? (
            <Markdown text={resource.content} />
          ) : (
            <p className="ip-vmuted">{resource.path ? `File: ${resource.path}` : resource.url || 'No content'}</p>
          )}
        </div>
      </div>
      <ToastRegion>
        {said && (
          <Toast key={said.id} tone={said.tone} onDismiss={() => setSaid((now) => (now?.id === said.id ? null : now))}>
            {said.text}
          </Toast>
        )}
      </ToastRegion>
    </div>
  );
}
