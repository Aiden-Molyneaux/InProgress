import { useEffect, useRef, useState } from 'react';

/** The frame's height before the page reports its own, and the tallest it grows: a page sized in vh would otherwise grow it with every height it reports. */
const START_HEIGHT = 160;
const MAX_HEIGHT = 20_000;

/**
 * An HTML page in a sandboxed frame (spec "Rendering"): scripts on, no same-origin, so it cannot reach the window's
 * origin, storage or API, and the frame route's CSP gives it no network but Google Fonts. Its height comes in by
 * postMessage, and only a finite number from this frame is taken.
 */
export function PageFrame({ resourceId, path, title }: { resourceId: number; path: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(START_HEIGHT);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      if (typeof event.data !== 'number' || !Number.isFinite(event.data)) return;
      setHeight(Math.min(MAX_HEIGHT, Math.max(START_HEIGHT, Math.ceil(event.data))));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div className="ip-pframe">
      <div className="ip-pframe-label">
        <span className="ip-pframe-path">{path}</span>
        <span>sandboxed frame · scripts on · no network · no same-origin</span>
      </div>
      <iframe
        ref={frame}
        className="ip-pframe-frame"
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={`/api/resources/${resourceId}/frame`}
        style={{ height }}
      />
    </div>
  );
}
