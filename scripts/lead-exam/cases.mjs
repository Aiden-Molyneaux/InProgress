// The exam's unseen cases (plan task 16). usage: node scripts/lead-exam/cases.mjs <copy> <out dir> [manifest of the 121]
// Answered asks (cleared, answer not empty) on personal projects, not among stage 0's 121: every review, and every
// question and permission cleared on or after 2026-11-21. Split by a hash of seed 743 and the ask id, each kind on its own, into half-a.txt (the exam now, gets the odd
// one) and half-b.txt (kept back for a rerun after a narrowing). Per case: <k>-<id>.md (what the lead sees) and
// <k>-<id>.key.md (with Aiden's answer, for the labellers), written as stage 0's gen-cases.cjs wrote them.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const [dbPath, out, manifest121 = process.env.EXAM_121] = process.argv.slice(2);
if (!dbPath || !out) throw new Error('usage: cases.mjs <copy> <out dir> [manifest of the 121]');
if (!manifest121 || !existsSync(manifest121)) throw new Error('the 121 manifest is needed: pass its path, or set EXAM_121');
const SINCE = '2026-11-21';
const WORK = /^(vcad|vvmc|cad-dev-loop)/;
const seen = new Set(
  readFileSync(manifest121, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => Number(l.split(' ')[1])),
);
const db = new Database(dbPath, { readonly: true });
// Half files once written are never regenerated: a half is the exam, and the other is kept back.
if (existsSync(join(out, 'half-a.txt')) || existsSync(join(out, 'half-b.txt'))) throw new Error(`${out} already has half files: use a new out dir`);
mkdirSync(out, { recursive: true });
const rows = db
  .prepare(
    `SELECT a.id, a.kind, a.project_id, a.node_id, a.text, a.answer, a.raised_at, a.cleared_at, n.title, p.slug
     FROM asks a JOIN nodes n ON n.id = a.node_id JOIN projects p ON p.id = a.project_id
     WHERE a.cleared_at IS NOT NULL AND a.answer <> '' ORDER BY a.id`,
  )
  .all()
  .filter((r) => !WORK.test(r.slug) && !seen.has(r.id))
  .filter((r) => r.kind === 'review' || ((r.kind === 'question' || r.kind === 'permission') && r.cleared_at >= SINCE));
const SEED = 743;
// The draw is a hash of the seed and the ask's id, so a case falls in the same half from any copy of the data.
const draw = (id) => createHash('sha256').update(`${SEED}:${id}`).digest().readUIntBE(0, 6);
// Each kind is split on its own: sorted by the draw, its first half is A (an odd one goes
// to A), the rest B; so each half holds its share of the questions and permissions.
const drawn = rows.map((r) => [draw(r.id), r]);
const inA = [];
const inB = [];
for (const kindName of ['question', 'review', 'permission']) {
  const ofKind = drawn.filter(([, r]) => r.kind === kindName).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const n = Math.ceil(ofKind.length / 2);
  inA.push(...ofKind.slice(0, n));
  inB.push(...ofKind.slice(n));
}
const lead = { question: 'asks', review: 'asks Aiden to review finished work', permission: 'asks Aiden for permission' };
const k = { question: 'q', review: 'r', permission: 'm' };
const line = (a) => `${k[a.kind]} ${a.id} ${a.project_id} ${a.raised_at}`;
for (const a of [...inA, ...inB]) {
  const text = `A session working on step #${a.node_id} (${a.title}) ${lead[a.kind]}:\n\n${a.text}\n`;
  writeFileSync(join(out, `${k[a.kind]}-${a.id}.md`), text);
  writeFileSync(join(out, `${k[a.kind]}-${a.id}.key.md`), `${text}\nAiden answered:\n\n${a.answer}\n`);
}
writeFileSync(join(out, 'half-a.txt'), inA.map(line).join('\n') + '\n');
writeFileSync(join(out, 'half-b.txt'), inB.map(line).join('\n') + '\n');
const count = (kind) => rows.filter((a) => a.kind === kind).length;
console.log(`cases ${rows.length}: questions ${count('question')}, reviews ${count('review')}, permissions ${count('permission')}`);
for (const [name, set] of [['A', inA], ['B', inB]]) console.log(`half ${name} ${set.length}: questions ${set.filter((a) => a.kind === 'question').length}, reviews ${set.filter((a) => a.kind === 'review').length}, permissions ${set.filter((a) => a.kind === 'permission').length}`);
