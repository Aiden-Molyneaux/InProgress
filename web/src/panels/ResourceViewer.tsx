import { useEffect, useRef, useState } from 'react';
import { isPagePurpose, type PageBody, type PageFreshness, type Resource } from '../../../src/core/types';
import { api, type PageRefusal } from '../api';
import { openLink } from '../links';
import { Button } from '../parts/Button';
import { ErrorLine } from '../parts/ErrorLine';
import { Eyebrow } from '../parts/Eyebrow';
import { Chip } from '../parts/Chip';
import { Toast, ToastRegion } from '../parts/Toast';
import { Markdown } from './Markdown';
import { PageFrame } from './PageFrame';

/** One line in the viewer's toast region: copy and open results, a failed open in alarm. */
interface Say {
  id: number;
  text: string;
  tone: 'neutral' | 'alarm';
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** What the strip says about the count: commits since the confirmation, or "confirm again" once it left the history. */
function countText(count: number | null): string {
  if (count === null) return 'confirm again';
  if (count === 0) return 'no commits since confirmed';
  return `${count} commit${count === 1 ? '' : 's'} since confirmed`;
}

/**
 * The freshness strip under the title (spec "Freshness"): the count of commits to the page's covers since it was
 * confirmed, when and at what sha, the covers, and Still accurate. Muted, and without the button, at 0.
 */
function FreshnessStrip({ fresh, covers, registeredAt, busy, onConfirm }: { fresh: PageFreshness; covers: string[]; registeredAt: string; busy: boolean; onConfirm: () => void }) {
  const current = fresh.count === 0;
  const how = fresh.confirmedAt === registeredAt ? 'at registration' : 'Still accurate';
  return (
    <div className="ip-fresh" data-current={current || undefined}>
      <span className="ip-fresh-count">{countText(fresh.count)}</span>
      {fresh.confirmedAt && (
        <span className="ip-fresh-when">{`confirmed ${DAY.format(new Date(fresh.confirmedAt))} · ${how}${fresh.confirmedSha ? ` · ${fresh.confirmedSha.slice(0, 7)}` : ''}`}</span>
      )}
      <span className="ip-fresh-covers" aria-label="Covers">
        {covers.map((c) => (
          <Chip key={c}>{c}</Chip>
        ))}
      </span>
      {!current && (
        <Button className="ip-fresh-confirm" variant="primary" size="sm" busy={busy} onClick={onConfirm}>
          Still accurate
        </Button>
      )}
    </div>
  );
}

/** Why a page cannot be shown, in the viewer's words. A secret's text never reaches the window, only its line. */
function PageRefused({ refusal, path }: { refusal: PageRefusal; path: string }) {
  if (refusal.code === 'page-missing') {
    return (
      <div className="ip-page-refused" role="status">
        <p className="ip-vmuted">This page is gone. It was at:</p>
        <p className="ip-page-path">{refusal.path ?? path}</p>
      </div>
    );
  }
  if (refusal.code === 'page-has-secret') {
    return (
      <div className="ip-page-refused" role="alert">
        <ErrorLine message={`This page looks like it holds a secret on line ${refusal.line}; fix it in its repo`} />
      </div>
    );
  }
  return <ErrorLine message={refusal.error} />;
}

export function ResourceViewer({ resourceId, onClose }: { resourceId: number; onClose: () => void }) {
  const [resource, setResource] = useState<Resource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<Say | null>(null);
  const [page, setPage] = useState<PageBody | PageRefusal | null>(null);
  const [confirming, setConfirming] = useState(false);
  const sayId = useRef(0);
  const body = useRef<HTMLDivElement>(null);

  // A page is read live from its file every time the viewer opens: the row first, then its body.
  useEffect(() => {
    let live = true;
    api
      .resource(resourceId)
      .then(async (r) => {
        if (!live) return;
        setResource(r);
        if (!isPagePurpose(r.purpose) || !r.path) return;
        const answer = await api.pageBody(r.id);
        if (live) setPage(answer.ok ? answer.body : answer);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
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
  const confirm = async () => {
    if (!resource) return;
    setConfirming(true);
    const answer = await api.confirmPage(resource.id);
    if (answer === 'reload') return window.location.reload();
    if (typeof answer === 'string') {
      setConfirming(false);
      return say(answer, 'alarm');
    }
    setResource(answer);
    const next = await api.pageBody(answer.id);
    setPage(next.ok ? next.body : next);
    setConfirming(false);
    say('Confirmed');
  };
  const isPage = !!resource?.path && isPagePurpose(resource.purpose);
  const pageBody = page && 'format' in page ? page : null;
  // Only web links open. The server accepts nothing else, and this keeps any other scheme away from window.open.
  const link = resource?.url && /^https?:/i.test(resource.url) ? resource.url : null;

  return (
    <div className="ip-viewer" role="dialog" aria-modal="true" aria-label="Resource">
      <header className="ip-vhead">
        <div className="ip-vtitle-block">
          {resource && <Eyebrow>{`R${resource.id} · ${resource.kind.toUpperCase()}${pageBody ? ` · ${pageBody.format === 'html' ? 'HTML' : 'MD'}` : ''}`}</Eyebrow>}
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
      {resource && pageBody?.fresh && (
        <FreshnessStrip fresh={pageBody.fresh} covers={pageBody.front.covers} registeredAt={resource.createdAt} busy={confirming} onConfirm={() => void confirm()} />
      )}
      <div ref={body} className="ip-viewer-body" tabIndex={0}>
        <div className="ip-viewer-doc" data-wide={pageBody?.format === 'html' || undefined}>
          {error ? (
            <ErrorLine message={error} />
          ) : !resource ? (
            <p className="ip-vmuted">Loading…</p>
          ) : isPage ? (
            !page ? (
              <p className="ip-vmuted">Loading…</p>
            ) : !pageBody ? (
              <PageRefused refusal={page as PageRefusal} path={resource.path!} />
            ) : pageBody.format === 'html' ? (
              <PageFrame resourceId={resource.id} path={resource.path!} title={resource.title} />
            ) : (
              <Markdown text={pageBody.text} />
            )
          ) : resource.content ? (
            <Markdown text={resource.content} />
          ) : (
            <p className="ip-vmuted">{resource.path ? `File: ${resource.path}` : resource.url || 'No content'}</p>
          )}
        </div>
      </div>
      <ToastRegion>
        {said && (
          <Toast key={said.id} tone={said.tone} onDismiss={() => {
              // The × that was pressed leaves with the toast: focus goes to the document pane, not to the page.
              if (document.activeElement?.closest('.p-toasts')) body.current?.focus();
              setSaid((now) => (now?.id === said.id ? null : now));
            }}>
            {said.text}
          </Toast>
        )}
      </ToastRegion>
    </div>
  );
}
