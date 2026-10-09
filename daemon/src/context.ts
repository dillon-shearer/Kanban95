// Builds the exact context an agent is given for a ticket. Everything else is pull (get_ticket, brain_search).
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { brainSearch, readTicket } from './api.js';
import { attachments } from './attachments.js';
import type { Role } from './grants.js';
import { TOOLS } from './mcp.js';
import { readPreferences } from './settings.js';
import { fill, loadTemplate, TEMPLATES, type Ctx, type TicketTemplate } from './templates.js';

const BRAIN_LIMIT = 8;
/** How many of the top rows carry their body; the rest are one line each, fetched with brain_search `id` when they apply. */
const BRAIN_BODIES = 2;
const BRAIN_CHARS = 2500;
export const BRAIN_TRUNCATED = '\n[brain truncated; search for more with brain_search]';

interface ContextOpts {
  /** The worktree and the branch the ticket forked from: `{{base}}` in every ticket prompt, and `git diff <base>...HEAD` for the test phase. */
  worktree?: string;
  base?: string;
  brainLimit?: number;
  brainChars?: number;
  /** The global brain: its rows join the brain section in the same ranking. Without it, the section is the project's only. */
  global?: DatabaseSync;
}

const orNone = (s: string) => s.trim() || '(none)';
const bullet = (head: string, body: string) => `- ${head}${body.replaceAll('\n', '\n  ')}`;

/**
 * Top matches for any word of the ticket's title and body across both brains, best first, a global row marked `[global]`: the
 * first BRAIN_BODIES with their body, the rest as an index line. Cut on row boundaries within `chars`, with a visible marker;
 * a body that does not fit falls back to its index line.
 */
export function brainFor(db: DatabaseSync, text: string, limit = BRAIN_LIMIT, chars = BRAIN_CHARS, global?: DatabaseSync): string {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])];
  if (words.length === 0) return '';
  // brainSearch quotes each word as an AND term; the brain section wants any word, so the OR query is built here.
  const rows = brainSearch({ project: db, global: global ?? db }, words.map((w) => `"${w}"`).join(' OR '), limit, global ? undefined : 'project', true);
  const room = chars - BRAIN_TRUNCATED.length;
  const lines: string[] = [];
  let used = -1; // no newline before the first line
  for (const [i, r] of rows.entries()) {
    const ref = `${r.scope === 'global' ? '[global] ' : ''}[#${r.id}] ${r.title}`;
    const index = `- ${ref}${r.tags ? ` · ${r.tags}` : ''}`;
    const line = [i < BRAIN_BODIES && bullet(`${ref}: `, r.body), index].find((l) => l && used + 1 + l.length <= room);
    if (!line) return lines.join('\n') + BRAIN_TRUNCATED;
    lines.push(line);
    used += 1 + line.length;
  }
  return lines.join('\n');
}

/** Failure notes written since the latest execute run started: what went wrong in the attempt now being retried. Older cycles are left out. */
function failureNotes(db: DatabaseSync, ticketId: number): string {
  const rows = db.prepare(`
    SELECT role, body FROM notes
    WHERE ticket_id = ? AND kind = 'failure'
      AND created_at >= coalesce((SELECT max(started_at) FROM runs WHERE ticket_id = ? AND phase = 'execute'), '')
    ORDER BY id`).all(ticketId, ticketId) as { role: string; body: string }[];
  return rows.map((r) => bullet(`[${r.role}] `, r.body)).join('\n');
}

/** The files the operator attached, by absolute path, for the agent to open with its own file reader. Empty when none. */
function attachmentList(repo: string, ticketId: number): string {
  const files = attachments(repo, ticketId);
  return files.length ? `Attachments (open with your file reader):\n${files.map((f) => `- ${f.path}`).join('\n')}` : '';
}

/** Left out of the inline diff (still named in the stat): docs and lockfiles were 40-100% of the large tester prompts (ticket #43). */
const DIFF_SKIP = [':(exclude)*.md', ':(exclude)docs/**', ':(exclude)*package-lock.json', ':(exclude)*.lock'];
const DIFF_CHARS = 32000;

/**
 * The tester's view of the change: `git diff --stat` of every file, then the diff of code and config only, capped at `chars`
 * with a marker telling the tester how to pull the rest. Push identifiers, not content: the tester reads what it needs per file.
 */
export function gitDiff(worktree: string, base: string, chars = DIFF_CHARS): string {
  const git = (...a: string[]) =>
    execFileSync('git', ['diff', '--no-color', '--no-ext-diff', ...a], { cwd: worktree, encoding: 'utf8', maxBuffer: 16 << 20 });
  const stat = git('--stat=200', '--stat-graph-width=20', `${base}...HEAD`).trimEnd();
  if (!stat) return '';
  const marker = `\n[diff truncated: run git diff ${base}...HEAD -- <path>]`;
  let body = git(`${base}...HEAD`, '--', ...DIFF_SKIP);
  if (body.length > chars) body = body.slice(0, chars - marker.length) + marker;
  return `${stat}\n\n${body}`.trimEnd();
}

/** A null ticket is a brainstorm or operator session: tools only, nothing pushed. `mission` is the operator terminal's, set by its launcher. */
export function buildContext(db: DatabaseSync, repo: string, ticketId: number | null, role: Role, opts: ContextOpts = {}): Ctx {
  const tools = Object.entries(TOOLS)
    .filter(([, t]) => role in t.access)
    .map(([name, t]) => `- ${name} (${t.access[role]})`)
    .join('\n');
  const preferences = orNone(readPreferences());
  if (ticketId === null) return { ticket: '(none)', criteria: '(none)', brain: '(none)', notes: '(none)', retry: '0', diff: '', tools, base: '(none)', preferences, mission: '(none)' };

  const t = readTicket(db, ticketId);
  let diff = '';
  if (role === 'tester') {
    if (!opts.worktree || !opts.base) throw new Error('a test context needs worktree and base for the diff');
    diff = orNone(gitDiff(opts.worktree, opts.base));
  }
  return {
    ticket: [`#${t.id} ${t.title}\n\n${t.body}`.trimEnd(), attachmentList(repo, t.id)].filter(Boolean).join('\n\n'),
    criteria: orNone(t.criteria),
    brain: orNone(brainFor(db, `${t.title} ${t.body}`, opts.brainLimit, opts.brainChars, opts.global)),
    notes: orNone(failureNotes(db, t.id)),
    retry: String(t.retry),
    diff,
    base: opts.base ?? '(none)',
    tools,
    preferences,
    mission: '(none)',
  };
}

/** Renders the template and records it on a new `runs` row before anything is spawned. The launcher spawns from the returned prompt. */
export function startRun(
  db: DatabaseSync,
  repo: string,
  r: { ticketId: number; template: TicketTemplate; cli: string; model: string; effort: string; sessionId?: string | null; global: DatabaseSync } & ContextOpts,
): { id: number; prompt: string } {
  const { role, phase } = TEMPLATES[r.template];
  const text = loadTemplate(repo, r.template); // a bad template fails here, before git runs or a row is written
  const prompt = fill(text, buildContext(db, repo, r.ticketId, role, r));
  const { lastInsertRowid } = db
    .prepare('INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(r.ticketId, phase, r.cli, r.model, r.effort, prompt, r.sessionId ?? null);
  return { id: Number(lastInsertRowid), prompt };
}
