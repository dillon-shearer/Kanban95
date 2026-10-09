// One git worktree per ticket: <repo>/.worktrees/t-<id> on branch ticket/<id>, forked from the repo's current branch.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { INNER_GITIGNORE } from './db.js';

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

export const worktreePath = (repo: string, ticketId: number) => join(repo, '.worktrees', `t-${ticketId}`);
export const branchName = (ticketId: number) => `ticket/${ticketId}`;

/** A plain folder's first `.gitignore`: the usual build output, the ticket worktrees and the board's own state. */
const FIRST_GITIGNORE = ['node_modules/', 'dist/', 'build/', '.worktrees/', ...INNER_GITIGNORE.split('\n').filter(Boolean).map((l) => `.kanban95/${l}`)].join('\n') + '\n';
export const FIRST_COMMIT = 'Start the Kanban95 board';

/**
 * On daemon start: makes a plain folder a local repo the board can run on. No `.git`: `git init`. No commit yet: a
 * `.gitignore` unless there is one, then everything is added and committed once as FIRST_COMMIT by the operator's own git
 * identity (`user.useConfigOnly`: git never makes one up from the host name). A repo with commits is left alone. Steps are
 * logged to stderr (stdout's first line is the handshake). Throws a message for the operator: git missing, or no identity.
 */
export function initRepo(repo: string): void {
  try {
    if (!existsSync(join(repo, '.git'))) {
      git(repo, 'init', '-q');
      console.error(`[git] ${repo} is not a git repo: ran git init`);
    }
    try {
      git(repo, 'rev-parse', '--verify', '-q', 'HEAD');
      return;
    } catch { /* no commit yet */ }
    if (!existsSync(join(repo, '.gitignore'))) {
      writeFileSync(join(repo, '.gitignore'), FIRST_GITIGNORE);
      console.error('[git] wrote .gitignore');
    }
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.useConfigOnly=true', 'commit', '-q', '--allow-empty', '-m', FIRST_COMMIT);
    console.error(`[git] committed the folder as "${FIRST_COMMIT}"`);
  } catch (e) {
    const { code, stderr } = e as { code?: string; stderr?: string };
    const reason = code === 'ENOENT' ? 'git is not installed or not on PATH; install it'
      : /tell me who you are|auto-detection is disabled|empty ident/i.test(stderr ?? '')
        ? 'git has no user.name or user.email; set both with git config --global'
        : (stderr ?? '').trim().split(/\r?\n/).pop() || (e as Error).message;
    throw new Error(`no git repo with a commit, so no ticket can launch: ${reason}, then restart the board`);
  }
}

/** Keeps .worktrees/ out of the operator's `git status` and out of any `git add -A` without touching a tracked file. */
function excludeWorktrees(repo: string) {
  const exclude = resolve(repo, git(repo, 'rev-parse', '--git-path', 'info/exclude'));
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!text.split(/\r?\n/).includes('/.worktrees/')) appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}/.worktrees/\n`);
}

/**
 * Creates the ticket's worktree, or returns the existing one (retries and the test phase reuse it). A rejected ticket whose
 * worktree was removed on merge gets a fresh one from the base, which holds its merged work.
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
  git(repo, 'worktree', 'prune'); // a worktree directory deleted by hand stays registered and blocks its branch
  // A branch left from an earlier cycle is reused when it holds work the base lacks; one already merged (a rejected ticket
  // whose branch survived cleanup) is reset to the base, which has that work and everything since.
  const exists = git(repo, 'branch', '--list', branch) !== '';
  const merged = exists && isAncestor(repo, branch, base);
  git(repo, 'worktree', 'add', ...(exists && !merged ? [path, branch] : [exists ? '-B' : '-b', branch, path, base]));
  return { path, branch, base };
}

export function isAncestor(repo: string, a: string, b: string): boolean {
  try {
    git(repo, 'merge-base', '--is-ancestor', a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merges the base branch (whatever the main checkout has) into the ticket's worktree, as a commit on the ticket branch authored
 * by the repo's git identity. Runs on submit and again in the merge queue, so conflicts are met here, never in the main checkout.
 * A conflict is aborted, leaving the worktree as it was. Uncommitted tracked changes are refused untouched; untracked files
 * (build output, test leftovers) are ignored. No worktree means nothing to sync. `reason` is the failure note.
 */
export function syncWorktree(repo: string, ticketId: number): { ok: true } | { ok: false; reason: string } {
  const path = worktreePath(repo, ticketId);
  if (!existsSync(path)) return { ok: true };
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: path, encoding: 'utf8' }).trimEnd(); // git() would trim the first line's status column
  if (dirty) return { ok: false, reason: `worktree has uncommitted changes; commit or discard them, then submit again:\n${dirty}` };
  const base = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  try {
    git(path, 'merge', '--no-edit', '-m', `Merge ${base} into ${branchName(ticketId)}`, base);
    return { ok: true };
  } catch (e) {
    try { git(path, 'merge', '--abort'); } catch { /* nothing to abort when the merge never started */ }
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    return { ok: false, reason: `merge conflict with ${base}: ${`${stdout ?? ''}${stderr ?? ''}`.trim() || (e as Error).message}` };
  }
}

/**
 * Removes the worktree and deletes the branch only if it is merged. Without `force` git refuses a worktree holding uncommitted
 * or untracked files; the janitor forces only once the branch has landed, when what is left is build output and test leftovers.
 */
export function removeWorktree(repo: string, ticketId: number, force = false): { branchDeleted: boolean } {
  const path = worktreePath(repo, ticketId);
  if (existsSync(path)) {
    unlinkLinks(repo, path);
    git(repo, 'worktree', 'remove', ...(force ? ['--force'] : []), path);
  }
  try {
    git(repo, 'branch', '-d', branchName(ticketId));
    return { branchDeleted: true };
  } catch {
    return { branchDeleted: false }; // unmerged or absent: the operator decides
  }
}

/**
 * Unlinks every junction and symlink under `dir` (and `dir` itself if it is one) without following it. Call it before deleting
 * anything under `.worktrees/`: `git worktree remove --force` followed a worktree's `node_modules` junction to the main
 * checkout's and emptied main's `daemon/`, and `rmSync` is not trusted to stop at a junction either. Node's lstat reports a
 * Windows junction as a symbolic link and `unlinkSync` removes the junction, not its target. Throws, deleting nothing more,
 * when a link that resolves into the main checkout outside `.worktrees/` could not be unlinked.
 */
export function unlinkLinks(repo: string, dir: string): void {
  const stuck: string[] = [];
  const visit = (path: string) => {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
      try {
        unlinkSync(path);
      } catch (e) {
        if (intoMain(repo, path)) stuck.push(`${path}: ${(e as Error).message}`);
      }
    } else if (st?.isDirectory()) {
      for (const d of readdirSync(path, { withFileTypes: true })) if (!d.isFile()) visit(join(path, d.name)); // a plain file is no link: skip its lstat
    }
  };
  visit(dir);
  if (stuck.length) throw new Error(`refusing to remove ${dir}: a link into the main checkout could not be unlinked\n${stuck.join('\n')}`);
}

/** Whether `link` resolves into `repo` outside `.worktrees/`. A link whose target cannot be read counts as in. */
function intoMain(repo: string, link: string): boolean {
  const within = (root: string, p: string) => {
    const rel = relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  try {
    let target: string;
    try {
      target = realpathSync.native(link);
    } catch {
      target = resolve(dirname(link), readlinkSync(link)); // a dangling link: where it would point
    }
    const root = realpathSync.native(repo);
    return within(root, target) && !within(join(root, '.worktrees'), target);
  } catch {
    return true;
  }
}

/**
 * For the ticket window: what the ticket's worktree holds (commits and uncommitted tracked changes) against the point where it
 * forked from the repo's current branch. Null when there is no worktree (never launched, or merged and cleaned up).
 */
export function ticketDiff(repo: string, ticketId: number): string | null {
  const path = worktreePath(repo, ticketId);
  if (!existsSync(path)) return null;
  const fork = git(path, 'merge-base', 'HEAD', git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'));
  return execFileSync('git', ['diff', '--no-color', '--no-ext-diff', fork], { cwd: path, encoding: 'utf8', maxBuffer: 16 << 20 });
}
