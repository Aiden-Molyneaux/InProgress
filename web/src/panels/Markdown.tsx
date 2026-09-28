import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' || node.tagName === 'AREA') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// HTML only, without <style>, style= or <form>, so Claude-written Markdown can't add page-wide CSS, inline styles, or a form that posts elsewhere.
const SANITIZE = { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] };

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, SANITIZE), [text]);
  return <div className="ip-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
