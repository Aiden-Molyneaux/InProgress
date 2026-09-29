import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

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

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, SANITIZE), [text]);
  return <div className="ip-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
