import type { LogEntry } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { badRequest } from '../errors';
import { requireNode } from './nodes';

interface LogRow {
  id: number;
  node_id: number;
  text: string;
  session_id: string | null;
  created_at: string;
  session_title: string | null;
}

const toLog = (r: LogRow): LogEntry => ({
  id: r.id,
  nodeId: r.node_id,
  text: r.text,
  sessionId: r.session_id,
  createdAt: r.created_at,
  sessionTitle: r.session_title,
});

export function addLog(ctx: Ctx, actor: string, nodeId: number, text: string, sessionId?: string | null): LogEntry {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, nodeId);
    const body = text.trim();
    if (!body) throw badRequest('Log text is empty');
    const info = ctx.db.prepare('INSERT INTO log_entries (node_id, text, session_id, created_at) VALUES (?, ?, ?, ?)').run(node.id, body, sessionId ?? null, ctx.now());
    const id = Number(info.lastInsertRowid);
    record({ projectId: node.projectId, type: 'log.created', entity: 'log', entityId: id, data: { nodeId: node.id } });
    const row = ctx.db.prepare('SELECT l.*, s.title AS session_title FROM log_entries l LEFT JOIN sessions s ON s.id = l.session_id WHERE l.id = ?').get(id) as LogRow;
    return toLog(row);
  });
}

export function listLogs(ctx: Ctx, nodeId: number, limit = 20): LogEntry[] {
  const rows = ctx.db
    .prepare('SELECT l.*, s.title AS session_title FROM log_entries l LEFT JOIN sessions s ON s.id = l.session_id WHERE l.node_id = ? ORDER BY l.id DESC LIMIT ?')
    .all(nodeId, limit) as LogRow[];
  return rows.reverse().map(toLog);
}
