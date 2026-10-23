import type { TreeNode } from '../../../src/core/types';
import { Eyebrow } from './Eyebrow';

/**
 * A step's What and Why, read-only: one row per field with text. On a step a session wrote, a field without text reads
 * "not written yet" and a step with neither reads "No What or Why yet". A step of Aiden's own (`me`) shows nothing for
 * what it lacks.
 */
export function WhatWhy({ node, className }: { node: Pick<TreeNode, 'what' | 'why' | 'origin'>; className?: string }) {
  const fields = [
    { word: 'WHAT', text: node.what.trim() },
    { word: 'WHY', text: node.why.trim() },
  ];
  const written = fields.filter((f) => f.text);
  if (written.length === 0) return node.origin === 'me' ? null : <p className={`ip-whatwhy-none${className ? ` ${className}` : ''}`}>No What or Why yet</p>;
  return (
    <div className={`ip-whatwhy${className ? ` ${className}` : ''}`}>
      {fields
        .filter((f) => f.text || node.origin !== 'me')
        .map((f) => (
          <div key={f.word} className="ip-whatwhy-row" data-field={f.word.toLowerCase()}>
            <Eyebrow>{f.word}</Eyebrow>
            {f.text ? <p>{f.text}</p> : <p className="ip-whatwhy-none">not written yet</p>}
          </div>
        ))}
    </div>
  );
}
