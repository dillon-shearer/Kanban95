// One git worktree per ticket: <board home>/worktrees/<repo key>/t-<id> on branch ticket/<id>, forked from the repo's current branch.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { INNER_GITIGNORE } from './db.js';
import { localHome, repoKey } from './settings.js';

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

/**
 * Windows' STATUS_DLL_INIT_FAILED (0xC0000142) as an exit code: the process never ran its first line. On a loaded machine
 * (2026-10-11, Windows 11, ~500-700 processes) git children of the daemon, vitest workers and an agent's cmd.exe or CLI in its
 * pty each failed to start this way now and then; starting the same thing again a moment later worked.
 */
export const notStarted = (code: unknown) => typeof code === 'number' && code >>> 0 === 0xc0000142;

/**
 * A failed git (execFile or execFileSync error) that never ran: it could not be spawned, did not start, or died before a word.
 * Git explains every failure it reaches, a conflict included, so an exit with no output at all is no verdict on the repo (under
 * the same load a merge-queue git once exited 1 with empty stdout and stderr): run it again.
 */
export function gitNotRun(e: unknown): boolean {
  const x = e as { status?: unknown; code?: unknown; stdout?: unknown; stderr?: unknown; syscall?: unknown; cmd?: unknown; output?: unknown };
  if (String(x.syscall ?? '').startsWith('spawn')) return true;
  if (x.cmd === undefined && x.output === undefined) return false; // not a child process's exit
  return notStarted(x.status ?? x.code) || !`${x.stdout ?? ''}${x.stderr ?? ''}`.trim();
}

/**
 * Where a repo's ticket worktrees live: `<local home>/worktrees/<basename>-<hash of the canonical path>`, never under the
 * repo. A repo in a synced folder (OneDrive) would otherwise upload every worktree's `npm ci`, get throttled, and lock files
 * so a worktree could not be removed. The key is settings.ts `repoKey`.
 */
export function worktreesRoot(repo: string): string {
  return join(localHome(), 'worktrees', repoKey(repo));
}
export const worktreePath = (repo: string, ticketId: number) => join(worktreesRoot(repo), `t-${ticketId}`);
export const branchName = (ticketId: number) => `ticket/${ticketId}`;

const SAFE_ENV = ['.env.example', '.env.sample', '.env.template'];
/** A plain folder's first `.gitignore`: the usual build output, env files and the board's own state. */
const FIRST_GITIGNORE = ['node_modules/', 'dist/', 'build/', '.env', '.env.*', ...SAFE_ENV.map((f) => `!${f}`), ...INNER_GITIGNORE.split('\n').filter(Boolean).map((l) => `.kanban95/${l}`)].join('\n') + '\n';
export const FIRST_COMMIT = 'Start the Kanban95 board';
const GIT_COPY_MARKS = ['.gitattributes', '.github'];

/** A path named `.env` or `.env.<anything>`, in any folder, except the usual templates: never in the first commit. Judged by name only. */
const isSecretPath = (p: string) => {
  const name = p.split('/').pop()!.toLowerCase();
  return (name === '.env' || name.startsWith('.env.')) && !SAFE_ENV.includes(name);
};

/**
 * On daemon start: makes a plain folder a local repo the board can run on. No `.git`: `git init`. No commit yet: a
 * `.gitignore` unless there is one, then everything is added and committed once as FIRST_COMMIT by the operator's own git
 * identity (`user.useConfigOnly`: git never makes one up from the host name). Env files (isSecretPath) are kept out of it
 * even when no `.gitignore` covers them; one the operator staged before the board ran stops it instead. A repo with commits
 * is left alone. Steps are logged to stderr (stdout's first line is the handshake). Throws a message for the operator: git
 * missing, no identity, or a staged env file.
 */
export function initRepo(repo: string): void {
  try {
    if (!existsSync(join(repo, '.git'))) {
      const marks = GIT_COPY_MARKS.filter((m) => existsSync(join(repo, m)));
      if (marks.length) {
        throw new Error(`the folder has ${marks.join(' and ')} but no .git, so it looks like a copy of a git repo; `
          + 'clone the repo with git clone so the board keeps its history and remote, or run git init yourself if it is new');
      }
      git(repo, 'init', '-q');
      console.error(`[git] ${repo} is not a git repo: ran git init`);
    }
    trustUnownedVolume(repo);
    try {
      git(repo, 'rev-parse', '--verify', '-q', 'HEAD');
      return;
    } catch { /* no commit yet */ }
    if (!existsSync(join(repo, '.gitignore'))) {
      writeFileSync(join(repo, '.gitignore'), FIRST_GITIGNORE);
      console.error('[git] wrote .gitignore');
    }
    const index = () => git(repo, 'ls-files', '-z').split('\0').filter(Boolean);
    const staged = index().filter(isSecretPath);
    if (staged.length) {
      throw new Error(`staged env file kept out of the first commit (${staged.join(', ')}); `
        + `unstage with git rm --cached -- ${staged.map((p) => `"${p}"`).join(' ')}, or make the first commit yourself`);
    }
    git(repo, 'add', '-A');
    const secrets = index().filter(isSecretPath);
    if (secrets.length) {
      git(repo, 'rm', '-q', '--cached', '--', ...secrets);
      console.error(`[git] left out of the first commit: ${secrets.join(', ')}`);
    }
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

function trustUnownedVolume(repo: string): void {
  try {
    git(repo, 'rev-parse', '--git-dir');
  } catch (e) {
    if (!/does ?not record ownership/i.test((e as { stderr?: string }).stderr ?? '')) return;
    const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
    process.env[`GIT_CONFIG_KEY_${n}`] = 'safe.directory';
    process.env[`GIT_CONFIG_VALUE_${n}`] = '*';
    process.env.GIT_CONFIG_COUNT = String(n + 1);
    console.error(`[git] ${repo} is on a volume that records no file owner (exFAT or FAT): trusted it for the board's git`);
  }
}

function volumeType(path: string): string | undefined {
  try {
    const device = execFileSync('df', ['-P', path], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').pop()!.split(/\s+/)[0];
    const info = execFileSync('diskutil', ['info', device], { encoding: 'utf8', stdio: 'pipe' });
    return /Type \(Bundle\):\s*(\S+)/.exec(info)?.[1].toLowerCase();
  } catch {
    return undefined;
  }
}

export function guardFileMode(repo: string, fsType: (path: string) => string | undefined = volumeType): boolean {
  if (process.platform !== 'darwin') return false;
  const type = fsType(repo);
  if (!type || type === 'apfs' || type.startsWith('hfs')) return false;
  if (git(repo, 'config', '--local', '--default', '', 'core.fileMode')) return false;
  git(repo, 'config', '--local', 'core.fileMode', 'false');
  console.error(`[git] ${repo} is on a ${type} volume, which keeps no file modes: set core.fileMode false`);
  return true;
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

  git(repo, 'worktree', 'prune'); // a worktree directory deleted by hand stays registered and blocks its branch
  // A ticket launched before worktrees left the repo has its branch checked out at the old place: move it, work and all.
  const old = checkedOut(repo, branch);
  if (old) {
    mkdirSync(dirname(path), { recursive: true });
    git(repo, 'worktree', 'move', old, path);
    return { path, branch, base };
  }
  const dirty = dirtyMessage(repo);
  if (dirty) throw new Error(`base branch ${base} has uncommitted changes${dirty}`);
  // A branch left from an earlier cycle is reused when it holds work the base lacks; one already merged (a rejected ticket
  // whose branch survived cleanup) is reset to the base, which has that work and everything since.
  const exists = git(repo, 'branch', '--list', branch) !== '';
  const merged = exists && isAncestor(repo, branch, base);
  git(repo, 'worktree', 'add', ...(exists && !merged ? [path, branch] : [exists ? '-B' : '-b', branch, path, base]));
  return { path, branch, base };
}

const KINDS: Record<string, string> = { D: 'deleted', M: 'modified', A: 'added', R: 'renamed', C: 'copied', T: 'type changed', U: 'unmerged' };

export function dirtyMessage(repo: string): string {
  const parts = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=no'], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).split('\0');
  const entries: { xy: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const xy = parts[i].slice(0, 2);
    entries.push({ xy, path: parts[i].slice(3) });
    if (/[RC]/.test(xy[0])) i++;
  }
  if (!entries.length) return '';
  const counts = new Map<string, number>();
  for (const { xy } of entries) {
    const kind = KINDS[xy.includes('U') ? 'U' : xy.includes('D') ? 'D' : (xy[1] !== ' ' ? xy[1] : xy[0])] ?? 'changed';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const summary = [...counts].map(([kind, n]) => `${n} ${kind}`).join(', ');
  const restore = entries.filter((e) => e.xy[1] === 'D' || e.xy[1] === 'M').map((e) => e.path);
  const command = restore.length > 10 ? 'git checkout -- .' : `git checkout -- ${restore.map((p) => `"${p}"`).join(' ')}`;
  const fix = restore.length ? `restore with ${command} in the repo, or commit or stash them before launching` : 'commit or stash them before launching';
  return ` (${summary}); ${fix}:\n${entries.map((e) => `${e.xy} ${e.path}`).join('\n')}`;
}

/** The linked worktree `branch` is checked out in, if any. The first entry git lists is the main checkout. */
function checkedOut(repo: string, branch: string): string | undefined {
  const entry = git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/).slice(1)
    .map((e) => e.split(/\r?\n/)).find((lines) => lines.includes(`branch refs/heads/${branch}`));
  return entry?.[0].replace(/^worktree /, '');
}

export function hasBranch(repo: string, ticketId: number): boolean {
  try {
    git(repo, 'rev-parse', '--verify', '-q', `refs/heads/${branchName(ticketId)}`);
    return true;
  } catch {
    return false;
  }
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
    if (gitNotRun(e)) throw e; // no conflict: the merge queue runs the job again
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    return { ok: false, reason: `merge conflict with ${base}: ${`${stdout ?? ''}${stderr ?? ''}`.trim() || (e as Error).message}` };
  }
}

/**
 * Removes the worktree and deletes the branch only if it is merged. Without `force` a worktree holding uncommitted or untracked
 * files is refused and left exactly as it was, links included: cleanliness is checked before anything is unlinked. The janitor
 * forces only once the branch has landed, when what is left is build output and test leftovers.
 */
export function removeWorktree(repo: string, ticketId: number, force = false, path = worktreePath(repo, ticketId)): { branchDeleted: boolean } {
  if (existsSync(path)) {
    if (force) {
      unlinkLinks(repo, path);
      git(repo, 'worktree', 'remove', '--force', path);
    } else removeIfClean(repo, path);
  }
  try {
    git(repo, 'branch', '-d', branchName(ticketId));
    return { branchDeleted: true };
  } catch {
    return { branchDeleted: false }; // unmerged or absent: the operator decides
  }
}

function removeIfClean(repo: string, path: string): void {
  if (!ownTree(path)) return void git(repo, 'worktree', 'remove', path);
  const changes = () =>
    execFileSync('git', ['status', '--porcelain', '-z', '--ignore-submodules=none'], { cwd: path, encoding: 'utf8', stdio: 'pipe' }).split('\0').filter(Boolean);
  const dirty = () => new Error(`'${path}' contains modified or untracked files, use --force to delete it`);
  if (changes().length) throw dirty();
  const unlinked: Link[] = [];
  try {
    unlinkLinks(repo, path, unlinked);
    const tracked = new Set(unlinked.map((l) => relative(path, l.path).replaceAll('\\', '/')));
    const left = changes();
    if (!left.every((c) => c.startsWith(' D ') && tracked.has(c.slice(3)))) throw dirty();
    git(repo, 'worktree', 'remove', ...(left.length ? ['--force'] : []), path);
  } catch (e) {
    relink(path, unlinked);
    throw e;
  }
}

function ownTree(path: string): boolean {
  try {
    return realpathSync.native(git(path, 'rev-parse', '--show-toplevel')) === realpathSync.native(path);
  } catch {
    return false;
  }
}

type Link = { path: string; target: string; dir: boolean };

function relink(tree: string, links: Link[]): void {
  for (const l of links) {
    try {
      if (lstatSync(l.path, { throwIfNoEntry: false })) continue;
      try {
        git(tree, 'checkout', '--', relative(tree, l.path));
      } catch {
        symlinkSync(l.target, l.path, l.dir ? 'junction' : 'file');
      }
    } catch {}
  }
}

/**
 * Unlinks every junction and symlink under `dir` (and `dir` itself if it is one) without following it, recording each in
 * `unlinked`. Call it before deleting a worktree: `git worktree remove --force` followed a worktree's `node_modules` junction
 * to the main checkout's and emptied main's `daemon/`, and `rmSync` is not trusted to stop at a junction either. Node's lstat
 * reports a Windows junction as a symbolic link and `unlinkSync` removes the junction, not its target. Throws, deleting
 * nothing more, when a link that resolves into the main checkout could not be unlinked.
 */
export function unlinkLinks(repo: string, dir: string, unlinked: Link[] = []): Link[] {
  const stuck: string[] = [];
  const visit = (path: string) => {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
      try {
        const link = { path, target: readlinkSync(path), dir: statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false };
        unlinkSync(path);
        unlinked.push(link);
      } catch (e) {
        if (intoMain(repo, path)) stuck.push(`${path}: ${(e as Error).message}`);
      }
    } else if (st?.isDirectory()) {
      for (const d of readdirSync(path, { withFileTypes: true })) if (!d.isFile()) visit(join(path, d.name)); // a plain file is no link: skip its lstat
    }
  };
  visit(dir);
  if (stuck.length) throw new Error(`refusing to remove ${dir}: a link into the main checkout could not be unlinked\n${stuck.join('\n')}`);
  return unlinked;
}

/** Whether `link` resolves into `repo`. A link whose target cannot be read counts as in. */
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
    return within(realpathSync.native(repo), target);
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
