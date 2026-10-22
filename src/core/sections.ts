import type { AdaptRow, DiffHunk } from './types';

/**
 * The one reader of a markdown file's sections (spec 2026-10-20-library-and-docs-design.md, "A project's Docs view"): the
 * Sync cell names a hunk by the heading above it, and a project's Docs view lines an adaptation up with its template by them.
 * Pure, so the server and the tests read a file the same way.
 */

export interface SectionStart {
  /** 0-based line of the heading, or of the paragraph a bold lead opens. */
  line: number;
  /** As written: the heading's text, or the bold lead's text without its stars. */
  title: string;
  /** A heading's level (1 to 6), or 0 for a bold paragraph lead. */
  level: number;
}

const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
// A paragraph that opens with a bold sentence, as the templates write their rules: `**The prime law [edit].** ...`.
const LEAD = /^\*\*([^*]+?\.)\*\*(?:\s|$)/;
const FENCE = /^\s*(```|~~~)/;

const lines = (text: string): string[] => text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');

/** Every heading and bold paragraph lead outside fenced code, in order. */
export function sectionStarts(text: string): SectionStart[] {
  const out: SectionStart[] = [];
  let fenced = false;
  lines(text).forEach((raw, line) => {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const l = raw.trimEnd();
    // Closing hashes are stripped only after a space, so `# C#` keeps its name.
    const h = HEADING.exec(l);
    if (h) return void out.push({ line, title: h[2], level: h[1].length });
    const lead = LEAD.exec(l);
    if (lead) out.push({ line, title: lead[1], level: 0 });
  });
  return out;
}

/** The last markdown heading at or above `line` (1-based) of `text`, ignoring fenced code; null when there is none. */
export function sectionAt(text: string, line: number): string | null {
  let found: string | null = null;
  for (const s of sectionStarts(text)) {
    if (s.line >= line) break;
    if (s.level > 0) found = s.title;
  }
  return found;
}

/** A section's name for matching: no `[edit]` mark, no closing period, one space, any case. */
export const sectionKey = (title: string): string =>
  title
    .replace(/\[edit\]/gi, '')
    .replace(/\.\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const HUNK_NEW = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * The old side of a unified diff whose new side is `text`: each hunk's new lines in `text` put back as its old lines. For the
 * adaptation diff that is Shipwright's template at base as the script filled it, so InProgress never fills a template itself.
 * Null when a hunk does not fit `text` (the copy changed between the diff and the read).
 */
export function unapply(text: string, hunks: readonly Pick<DiffHunk, 'header' | 'lines'>[]): string | null {
  const src = lines(text);
  const out: string[] = [];
  let at = 0;
  for (const h of hunks) {
    const m = HUNK_NEW.exec(h.header);
    if (!m) return null;
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A hunk with no new lines names the line before the place it takes.
    const start = count === 0 ? Number(m[1]) : Number(m[1]) - 1;
    if (start < at || start > src.length) return null;
    out.push(...src.slice(at, start));
    at = start;
    for (const l of h.lines) {
      if (l.kind === '-') out.push(l.text);
      else if (src[at] === undefined || src[at].trimEnd() !== l.text.trimEnd()) return null;
      else {
        if (l.kind === ' ') out.push(src[at]);
        at++;
      }
    }
  }
  out.push(...src.slice(at));
  return out.join('\n');
}

interface Part {
  key: string;
  title: string;
  level: number;
  /** The section's text without its heading line (a lead keeps its paragraph), blank edges trimmed. */
  body: string;
  /** 1-based first and last lines, the heading included. */
  from: number;
  to: number;
}

const OPENING = 'Opening';

/**
 * A file cut at its level 2 and 3 headings and its bold paragraph leads; the text before the first is the Opening. A lead
 * covers its own paragraph only: the plain text after it, up to the next section, is a continuation of the heading above
 * (level -2, keyed `<heading>~<n>`), so a section a project adds between a lead and that text does not swallow it. A key
 * repeated in one file takes its occurrence (`why#2`), so a second "Why." matches the second.
 */
function parts(text: string): Part[] {
  const all = lines(text);
  const starts = sectionStarts(text).filter((s) => s.level === 0 || s.level === 2 || s.level === 3);
  const seen = new Map<string, number>();
  const out: Part[] = [];
  const body = (from: number, to: number): string =>
    all
      .slice(from, to)
      .map((l) => l.trimEnd())
      .join('\n')
      .replace(/^\n+|\n+$/g, '');
  const push = (base: string, title: string, level: number, from: number, to: number, text: string) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ key: n === 1 ? base : `${base}#${n}`, title, level, body: text, from: from + 1, to });
  };
  // The heading a lead sits under, and how many continuations it has had. `push` must run in file order: the `~n` here and the
  // `#n` it adds for a repeated key both count as the file is read.
  let parent = { key: '', title: OPENING, continued: 0 };
  push('', OPENING, -1, 0, starts[0]?.line ?? all.length, body(0, starts[0]?.line ?? all.length));
  starts.forEach((s, i) => {
    const end = starts[i + 1]?.line ?? all.length;
    if (s.level > 0) {
      parent = { key: sectionKey(s.title), title: s.title, continued: 0 };
      return push(parent.key, s.title, s.level, s.line, end, body(s.line + 1, end));
    }
    let para = s.line + 1;
    while (para < end && all[para].trim() !== '') para++;
    push(sectionKey(s.title), s.title, 0, s.line, para, body(s.line, para));
    const rest = body(para, end);
    if (rest !== '') {
      parent.continued++;
      push(`${parent.key}~${parent.continued}`, parent.title, -2, para, end, rest);
    }
  });
  return out;
}

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

/**
 * The side by side of a project's copy against its template (spec "A project's Docs view"): one row per section of the
 * filled template at base, in its order, with the raw template's text (placeholders kept) for the left column and the copy's
 * for the right, tagged:
 * - `same`: the copy says what the filled template says and the project filled no placeholder there (the view folds these);
 * - `fill` or `file fill`: the same, with a placeholder the project filled (a file fill when the file's own fills name one);
 * - `rewritten`: the copy says something else; `removed`: the copy has no such section;
 * - `added`: a section of the copy the template does not have, placed after the row it follows in the copy.
 * `conflict` marks a copy section that one of `conflictRanges` (the merge's 1-based first line and count in the copy) overlaps.
 */
export function sideBySide({ raw, filled, local, fills, fileFills, conflictRanges }: { raw: string; filled: string; local: string; fills: readonly string[]; fileFills: readonly string[]; conflictRanges: readonly { start: number; lines: number }[] }): AdaptRow[] {
  const rawParts = new Map(parts(raw).map((p) => [p.key, p]));
  const localParts = parts(local);
  const byKey = new Map(localParts.map((p) => [p.key, p]));
  // A range of no lines is a point: the merge's place between two lines of the copy.
  const conflicted = (p: Part): boolean => conflictRanges.some((r) => r.start <= p.to && r.start + Math.max(r.lines, 1) - 1 >= p.from);
  const rows: AdaptRow[] = [];
  const matched = new Set<string>();
  // Where each filled row landed, so an added section can follow the row it follows in the copy.
  const rowOf = new Map<string, number>();
  for (const f of parts(filled)) {
    const r = rawParts.get(f.key);
    const template = r ? r.body : f.body;
    const placeholders = [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];
    const filledHere = placeholders.filter((p) => fills.includes(p));
    const l = byKey.get(f.key);
    const base = { key: f.key, title: f.title, level: f.level, template, placeholders };
    if (!l) {
      rows.push({ ...base, tag: 'removed', project: null, conflict: false });
      continue;
    }
    matched.add(f.key);
    const tag: AdaptRow['tag'] = l.body !== f.body ? 'rewritten' : filledHere.length === 0 ? 'same' : filledHere.some((p) => fileFills.includes(p)) ? 'file fill' : 'fill';
    rowOf.set(f.key, rows.length);
    rows.push({ ...base, tag, project: l.body, conflict: conflicted(l) });
  }
  // Added sections, each after the last matched section above it in the copy (or at the top), in the copy's order.
  const inserts = new Map<number, AdaptRow[]>();
  let after = -1;
  for (const l of localParts) {
    if (matched.has(l.key)) {
      after = rowOf.get(l.key) ?? after;
      continue;
    }
    const list = inserts.get(after) ?? [];
    list.push({ key: l.key, title: l.title, level: l.level, template: null, placeholders: [], tag: 'added', project: l.body, conflict: conflicted(l) });
    inserts.set(after, list);
  }
  const out: AdaptRow[] = [...(inserts.get(-1) ?? [])];
  rows.forEach((row, i) => out.push(row, ...(inserts.get(i) ?? [])));
  return out;
}
