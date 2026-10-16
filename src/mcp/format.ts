import { formatUpNext, queueView } from '../core/layout';
import { glyphTitle, type NodeDetail, type ProjectSnapshot, type Resource, type SearchResult, type TreeNode } from '../core/types';

/**
 * The queue after a set_queue, as the outline prints it: `Up next: "Store listing": #82 → #78 | later: #79`. With no step up next it
 * says the queue is empty (an empty write clears only its owner's entries, so that is worth saying), unless open steps
 * are still queued: then they are sessions' own focuses, which are "now", not "next".
 */
export function formatQueue(s: ProjectSnapshot): string {
  const line = formatUpNext(queueView(s.project.queue, s.nodes, s.sessions), s.sessions);
  if (line) return line;
  return s.project.queue.length ? `Nothing is up next in ${s.project.slug}: a session's own focus is not listed as next.` : `Up next in ${s.project.slug} is empty.`;
}

export function formatCreated(nodes: TreeNode[]): string {
  return nodes
    .map((n) => `#${n.id} ${glyphTitle(n)} (${n.kind}, ${n.status}${n.assignee === 'me' ? ', you' : ''}) under #${n.parentId}`)
    .join('\n');
}

export function formatNodeDetail(d: NodeDetail): string {
  const n = d.node;
  const lines = [`#${n.id} ${glyphTitle(n)} (${n.kind}${n.label ? `, ${n.label}` : ''}) · ${n.status}, ${n.assignee === 'me' ? 'assigned to Aiden' : 'Claude'}`];
  if (d.parent) lines.push(`Parent: #${d.parent.id} ${d.parent.title}`);
  if (n.body) lines.push(`Body:\n${n.body}`);
  if (n.outcome) lines.push(`Outcome: ${n.outcome}`);
  if (d.children.length) lines.push('Children:', ...d.children.map((c) => `  #${c.id} ${c.title} · ${c.status}${c.assignee === 'me' ? ' (you)' : ''}`));
  if (d.resources.length) lines.push('Resources:', ...d.resources.map((r) => `  r${r.id} ${r.title} (${r.kind})${r.path ? ` ${r.path}` : ''}`));
  if (d.log.length) lines.push('Log:', ...d.log.map((l) => `  ${l.createdAt} ${l.text}`));
  return lines.join('\n');
}

export function formatResource(r: Resource): string {
  const lines = [`r${r.id} ${r.title} (${r.kind}) on #${r.nodeId}`];
  if (r.path) lines.push(`Path: ${r.path}`);
  if (r.url) lines.push(`URL: ${r.url}`);
  if (r.content) lines.push('Content:', r.content);
  return lines.join('\n');
}

export function formatSearch(s: SearchResult): string {
  if (!s.nodes.length && !s.resources.length) return 'No matches.';
  return [
    ...s.nodes.map((n) => `#${n.id} ${n.title} · ${n.status}`),
    ...s.resources.map((r) => `r${r.id} ${r.title} (${r.kind}) on #${r.nodeId}`),
  ].join('\n');
}
