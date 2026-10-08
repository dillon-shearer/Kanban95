// One git worktree per ticket: <repo>/.worktrees/t-<id> on branch ticket/<id>, forked from the repo's current branch.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

export const worktreePath = (repo: string, ticketId: number) => join(repo, '.worktrees', `t-${ticketId}`);
export const branchName = (ticketId: number) => `ticket/${ticketId}`;

/** Keeps .worktrees/ out of the operator's `git status` and out of any `git add -A` without touching a tracked file. */
function excludeWorktrees(repo: string) {
  const exclude = resolve(repo, git(repo, 'rev-parse', '--git-path', 'info/exclude'));
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!text.split(/\r?\n/).includes('/.worktrees/')) appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}/.worktrees/\n`);
}

/**
 * Creates the ticket's worktree, or returns the existing one (retries and the test phase reuse it).
 * Refuses when the base branch has uncommitted changes to tracked files: the ticket would silently fork without them.
 * Untracked files do not count; they are not part of any commit either way.
 */
export function createWorktree(repo: string, ticketId: number): { path: string; branch: string; base: string } {
  const path = worktreePath(repo, ticketId);
  const branch = branchName(ticketId);
  const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (existsSync(path)) return { path, branch, base };

  const dirty = git(repo, 'status', '--porcelain', '--untracked-files=no');
  if (dirty) throw new Error(`base branch ${base} has uncommitted changes; commit or stash them before launching:\n${dirty}`);
  excludeWorktrees(repo);
  const exists = git(repo, 'branch', '--list', branch) !== '';
  git(repo, 'worktree', 'add', ...(exists ? [path, branch] : ['-b', branch, path, base]));
  return { path, branch, base };
}

/** Removes the worktree (git refuses if it holds uncommitted work) and deletes the branch only if it is merged. */
export function removeWorktree(repo: string, ticketId: number): { branchDeleted: boolean } {
  const path = worktreePath(repo, ticketId);
  if (existsSync(path)) git(repo, 'worktree', 'remove', path);
  try {
    git(repo, 'branch', '-d', branchName(ticketId));
    return { branchDeleted: true };
  } catch {
    return { branchDeleted: false }; // unmerged or absent: the operator decides
  }
}
