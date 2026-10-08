// Builds the exact context an agent is given for a ticket. Everything else is pull (get_ticket, brain_search).
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { readTicket } from './api.js';
import type { Role } from './grants.js';
import { TOOLS } from './mcp.js';
import { fill, loadTemplate, TEMPLATES, type Ctx, type TemplateName } from './templates.js';

export const BRAIN_LIMIT = 5;
export const BRAIN_CHARS = 4000;
export const BRAIN_TRUNCATED = '\n[brain truncated; search for more with brain_search]';

export interface ContextOpts {
  /** Test phase only: the worktree and the branch the ticket forked from, for `git diff <base>...HEAD`. */
  worktree?: string;
  base?: string;
  brainLimit?: number;
  brainChars?: number;
}

const orNone = (s: string) => s.trim() || '(none)';
const bullet = (head: string, body: string) => `- ${head}${body.replaceAll('\n', '\n  ')}`;

/** Top matches for any word of the ticket's title and body, best first, as a list capped at `chars` with a visible marker when cut. */
export function brainFor(db: DatabaseSync, text: string, limit = BRAIN_LIMIT, chars = BRAIN_CHARS): string {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])];
  if (words.length === 0) return '';
  const rows = db
    .prepare('SELECT b.id, b.title, b.body FROM brain_fts f JOIN brain b ON b.id = f.rowid WHERE brain_fts MATCH ? ORDER BY rank, b.id LIMIT ?')
    .all(words.map((w) => `"${w}"`).join(' OR '), limit) as { id: number; title: string; body: string }[];
  const out = rows.map((r) => bullet(`[#${r.id}] ${r.title}: `, r.body)).join('\n');
  return out.length > chars ? out.slice(0, chars - BRAIN_TRUNCATED.length) + BRAIN_TRUNCATED : out;
}

/** Failure notes written since the latest execute run started: what went wrong in the attempt now being retried. Older cycles are left out. */
export function failureNotes(db: DatabaseSync, ticketId: number): string {
  const rows = db.prepare(`
    SELECT role, body FROM notes
    WHERE ticket_id = ? AND kind = 'failure'
      AND created_at >= coalesce((SELECT max(started_at) FROM runs WHERE ticket_id = ? AND phase = 'execute'), '')
    ORDER BY id`).all(ticketId, ticketId) as { role: string; body: string }[];
  return rows.map((r) => bullet(`[${r.role}] `, r.body)).join('\n');
}

function gitDiff(worktree: string, base: string): string {
  // ponytail: the whole diff is injected; truncate with a marker if prompts outgrow the CLIs' input limits.
  return execFileSync('git', ['diff', '--no-color', '--no-ext-diff', `${base}...HEAD`], { cwd: worktree, encoding: 'utf8', maxBuffer: 16 << 20 });
}

/** A null ticket is a brainstorm session: tools only, nothing pushed. */
export function buildContext(db: DatabaseSync, ticketId: number | null, role: Role, opts: ContextOpts = {}): Ctx {
  const tools = Object.entries(TOOLS)
    .filter(([, t]) => role in t.access)
    .map(([name, t]) => `- ${name} (${t.access[role]})`)
    .join('\n');
  if (ticketId === null) return { ticket: '(none)', criteria: '(none)', brain: '(none)', notes: '(none)', retry: '0', diff: '', tools };

  const t = readTicket(db, ticketId);
  let diff = '';
  if (role === 'tester') {
    if (!opts.worktree || !opts.base) throw new Error('a test context needs worktree and base for the diff');
    diff = orNone(gitDiff(opts.worktree, opts.base));
  }
  return {
    ticket: `#${t.id} ${t.title}\n\n${t.body}`.trimEnd(),
    criteria: orNone(t.criteria),
    brain: orNone(brainFor(db, `${t.title} ${t.body}`, opts.brainLimit, opts.brainChars)),
    notes: orNone(failureNotes(db, t.id)),
    retry: String(t.retry),
    diff,
    tools,
  };
}

/** Renders the template and records it on a new `runs` row before anything is spawned. The launcher spawns from the returned prompt. */
export function startRun(
  db: DatabaseSync,
  repo: string,
  r: { ticketId: number; template: Exclude<TemplateName, 'brainstorm'>; cli: string; model: string; effort: string } & ContextOpts,
): { id: number; prompt: string } {
  const { role, phase } = TEMPLATES[r.template];
  const text = loadTemplate(repo, r.template); // a bad template fails here, before git runs or a row is written
  const prompt = fill(text, buildContext(db, r.ticketId, role, r));
  const { lastInsertRowid } = db
    .prepare('INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered) VALUES (?, ?, ?, ?, ?, ?)')
    .run(r.ticketId, phase, r.cli, r.model, r.effort, prompt);
  return { id: Number(lastInsertRowid), prompt };
}
