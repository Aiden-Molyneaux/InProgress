import { useMemo, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { Marked, marked } from 'marked';
import { onLinkClick } from '../links';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' || node.tagName === 'AREA') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  // Task lists keep their checkboxes, disabled. Any other input goes.
  if (node.tagName === 'INPUT') {
    if (node.getAttribute('type')?.toLowerCase() === 'checkbox') node.setAttribute('disabled', '');
    else node.remove();
  }
});

// HTML only: no <style>, <form>, style= or class=, so Claude-written Markdown can't restyle the app, borrow its classes to overlay it, or post a form.
// No textarea, select or button either: with the input rule above, nothing in a resource can take focus and keep Escape from closing the viewer.
const SANITIZE = { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'textarea', 'select', 'button'], FORBID_ATTR: ['style', 'class'] };

/** The ids the step-ref extension turns into links, set around each parse (a parse is synchronous). */
let knownStep: (id: number) => boolean = () => false;

/** A Markdown reader that also links `#<digits>` at a word start, outside code, to the step it names (see `stepRefs`). */
const stepMarked = new Marked({
  extensions: [
    {
      name: 'stepRef',
      level: 'inline',
      start: (src: string) => /(?<![\w#])#\d/.exec(src)?.index,
      tokenizer(src: string) {
        const m = /^#(\d+)(?!\w)/.exec(src);
        if (!m || !knownStep(Number(m[1]))) return undefined;
        return { type: 'stepRef', raw: m[0], id: Number(m[1]) };
      },
      renderer: (token) => `<a href="#step-${token.id}" data-step="${token.id}">#${token.id}</a>`,
    },
  ],
});

export interface StepRefs {
  has: (id: number) => boolean;
  open: (id: number) => void;
}

/** `stepRefs`: with it, a `#id` of a step that `has` knows is a link that calls `open` instead of leaving the app. */
export function Markdown({ text, stepRefs }: { text: string; stepRefs?: StepRefs }) {
  const has = stepRefs?.has;
  const html = useMemo(() => {
    let parsed: string;
    if (has) {
      knownStep = has;
      try {
        parsed = stepMarked.parse(text, { async: false }) as string;
      } finally {
        knownStep = () => false;
      }
    } else {
      parsed = marked.parse(text, { async: false }) as string;
    }
    return DOMPurify.sanitize(parsed, SANITIZE);
  }, [text, has]);
  const click = (event: MouseEvent<HTMLDivElement>) => {
    const link = stepRefs && event.target instanceof Element ? event.target.closest<HTMLElement>('a[data-step]') : null;
    if (link && stepRefs) {
      event.preventDefault();
      stepRefs.open(Number(link.dataset.step));
      return;
    }
    onLinkClick(event);
  };
  // Links go to the default browser, not the browser hosting this window.
  return <div className="ip-md" onClick={click} dangerouslySetInnerHTML={{ __html: html }} />;
}
