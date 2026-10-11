// Removes what the board created once nothing needs it. Every deletion writes an audit row (tool `janitor.*`, no grant).
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { git, removeWorktree, unlinkLinks, worktreePath, worktreesRoot } from './git.js';
import { audit, revoke } from './grants.js';
import { sessions } from './launcher.js';

const SCROLLBACK_DAYS = 30;
export const SWEEP_MS = 24 * 60 * 60 * 1000;

type Board = { db: DatabaseSync; repo: string };
const log = (db: DatabaseSync, ticket: number | null, tool: string, args: unknown, outcome: 'ok' | 'error' = 'ok') =>
  audit(db, { grant_id: null, ticket_id: ticket, tool, args, outcome });
const message = (e: unknown) => ((e as { stderr?: string }).stderr || (e as Error).message).trim();
// A directory something still holds open (a running exe, an editor, OneDrive) is left for the next sweep, never fatal.
// Links inside are unlinked first, so the delete never reaches through a junction into the main checkout.
const remove = (repo: string, path: string): string | undefined => {
  try {
    unlinkLinks(repo, path);
    rmSync(path, { recursive: true, force: true });
  } catch (e) {
    return message(e);
  }
};

/**
 * After a ticket's branch has landed: its worktree (forced, the committed work is on the base now; what is left is build
 * output and test leftovers) and its branch. Windows keeps a directory locked for a moment after the agent that sat in it
 * exits, longer on a loaded machine (over 2 s seen in a full test run beside other agents), so the removal is retried for about
 * ten seconds before it is given up and audited as an error.
 */
export async function cleanTicket(b: Board, id: number): Promise<void> {
  const path = worktreePath(b.repo, id);
  for (let attempt = 1; ; attempt++) {
    try {
      const { branchDeleted } = removeWorktree(b.repo, id, true);
      log(b.db, id, 'janitor.worktree', { path, branchDeleted });
      return;
    } catch (e) {
      if (attempt === 25) return log(b.db, id, 'janitor.worktree', { path, error: message(e) }, 'error');
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

/**
 * On daemon start and once a day. Orphans only: a worktree whose ticket is gone or merged, a session dir or grant with no live
 * session, an unfinished run with no live session. A worktree of an unmerged ticket is never touched: it may hold the only copy of work.
 */
export function sweep(b: Board): void {
  const { db, repo } = b;
  const live = [...sessions.values()];

  const wtRoot = worktreesRoot(repo);
  const legacy = join(repo, '.worktrees'); // the old layout's worktrees, under the repo: removed once, then the empty directory
  if (existsSync(wtRoot) || existsSync(legacy)) {
    // Forget registrations whose directory is already gone. A failure here (git itself refused to start with EPERM once, in a
    // loaded full test run) is audited and the sweep goes on: inside start() a throw left the daemon never listening.
    try { git(repo, 'worktree', 'prune'); } catch (e) { log(db, null, 'janitor.worktree', { prune: true, error: message(e) }, 'error'); }
  }
  for (const root of [wtRoot, legacy]) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const id = Number(/^t-(\d+)$/.exec(name)?.[1]);
      if (!id || live.some((s) => s.ticketId === id)) continue;
      const t = db.prepare('SELECT merged_at FROM tickets WHERE id = ?').get(id) as { merged_at: string | null } | undefined;
      // An unmerged ticket's worktree in the old layout stays too; its next launch moves it to the new root (createWorktree).
      if (t && t.merged_at === null) continue;
      const ticket = t ? id : null;
      const path = join(root, name);
      try {
        // A deleted ticket's worktree is removed only if clean; its branch stays unless merged, so commits are never lost.
        const { branchDeleted } = removeWorktree(repo, id, t !== undefined, path);
        log(db, ticket, 'janitor.worktree', { path, branchDeleted });
      } catch (e) {
        if (!/is not a working tree/.test(message(e))) {
          log(db, ticket, 'janitor.worktree', { path, error: message(e) }, 'error');
          continue;
        }
        const error = remove(repo, path); // a directory git does not know: left over, not a worktree
        log(db, ticket, 'janitor.worktree', { path, registered: false, error }, error ? 'error' : 'ok');
      }
    }
  }
  if (existsSync(legacy) && readdirSync(legacy).length === 0) {
    const error = remove(repo, legacy); // OneDrive may still hold it: left for the next sweep
    log(db, null, 'janitor.worktree', { path: legacy, error }, error ? 'error' : 'ok');
  }

  const sessRoot = join(repo, '.kanban95', 'sessions');
  if (existsSync(sessRoot)) {
    for (const name of readdirSync(sessRoot)) {
      if (sessions.has(Number(name))) continue;
      const error = remove(repo, join(sessRoot, name));
      log(db, null, 'janitor.session', { dir: join(sessRoot, name), error }, error ? 'error' : 'ok');
    }
  }

  const now = new Date().toISOString();
  const liveGrants = new Set(live.map((s) => s.grantId));
  for (const g of db.prepare('SELECT id, ticket_id FROM grants WHERE revoked_at IS NULL AND expires_at > ?').all(now) as { id: number; ticket_id: number | null }[]) {
    if (liveGrants.has(g.id)) continue;
    revoke(db, g.id);
    log(db, g.ticket_id, 'janitor.grant', { grant: g.id });
  }
  const liveRuns = new Set(live.map((s) => s.runId));
  for (const r of db.prepare('SELECT id, ticket_id FROM runs WHERE ended_at IS NULL').all() as { id: number; ticket_id: number }[]) {
    if (liveRuns.has(r.id)) continue;
    db.prepare("UPDATE runs SET ended_at = ?, outcome = coalesce(outcome, 'lost') WHERE id = ?").run(now, r.id);
    log(db, r.ticket_id, 'janitor.run', { run: r.id });
  }

  const cutoff = new Date(Date.now() - SCROLLBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { changes } = db.prepare('UPDATE runs SET scrollback = NULL WHERE scrollback IS NOT NULL AND ended_at < ?').run(cutoff);
  if (changes) log(db, null, 'janitor.scrollback', { runs: Number(changes), before: cutoff });
  db.exec('VACUUM');
}
