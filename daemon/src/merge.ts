// The one merge queue: every job runs after the previous one has finished, so two tickets never merge at once.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { branchName } from './git.js';

const run = promisify(execFile);
const git = (repo: string, ...args: string[]) => run('git', args, { cwd: repo, encoding: 'utf8' });

let tail: Promise<void> = Promise.resolve();

/** Runs `job` after every job queued before it. A failing job does not stop the queue. */
export function enqueue(job: () => Promise<void>): Promise<void> {
  tail = tail.then(job).catch((e) => console.error('[merge]', e));
  return tail;
}

/** Resolves when the queue is empty. */
export const idle = () => tail;

/** `dirty`: refused before git merge ran; `reason` is then the `git status` lines. Otherwise `reason` is git's output. */
type MergeResult = { ok: true } | { ok: false; dirty: boolean; base: string; reason: string };

/**
 * `git merge --no-ff ticket/<id>` into whatever branch the main working tree has checked out, authored by the repo's own
 * git identity. The message is the ticket title, one line, nothing appended. Any failure is aborted, leaving the base as it was.
 * A base with uncommitted changes is never merged into, so `merge --abort` never runs over the operator's edits.
 * `wanted` is asked last, with no await between it and the merge starting; `null` when it says no (the ticket was rejected
 * or moved while the checks above ran).
 */
export async function merge(repo: string, ticketId: number, title: string, wanted = () => true): Promise<MergeResult | null> {
  const base = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  const { stdout: dirty } = await git(repo, 'status', '--porcelain', '--untracked-files=no');
  if (dirty.trim()) return { ok: false, dirty: true, base, reason: dirty.trimEnd() };
  if (!wanted()) return null;
  try {
    await git(repo, 'merge', '--no-ff', '--no-edit', '-m', title.split(/\r?\n/)[0].trim(), branchName(ticketId));
    return { ok: true };
  } catch (e) {
    await git(repo, 'merge', '--abort').catch(() => {}); // nothing to abort when the merge never started
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    return { ok: false, dirty: false, base, reason: `${stdout ?? ''}${stderr ?? ''}`.trim() || (e as Error).message };
  }
}

/** The main checkout's branch, its upstream remote and the branch there; `null` when the branch tracks nothing. */
async function upstream(repo: string): Promise<{ base: string; remote: string; ref: string } | null> {
  try {
    const base = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
    const remote = (await git(repo, 'config', `branch.${base}.remote`)).stdout.trim();
    const ref = (await git(repo, 'config', `branch.${base}.merge`)).stdout.trim();
    return remote && ref ? { base, remote, ref } : null;
  } catch {
    return null; // git config exits 1 for an unset key; rev-parse fails in a repo with no commits
  }
}

/** Commits on the main checkout's branch that its upstream lacks (as last fetched or pushed); 0 with no upstream. */
export async function ahead(repo: string): Promise<number> {
  if (!(await upstream(repo))) return 0;
  try {
    return Number((await git(repo, 'rev-list', '--count', '@{u}..HEAD')).stdout.trim());
  } catch {
    return 0; // the upstream branch was never fetched: nothing to compare against
  }
}

type PushResult = { ok: true; pushed: boolean } | { ok: false; base: string; remote: string; reason: string };

/**
 * `git push <remote> <base>:<upstream branch>` from the main checkout: the whole base, so earlier unpushed commits go with it.
 * Git signs in with the operator's own credential helper or SSH agent; the board never sees them. No terminal prompt, so a
 * missing credential fails instead of hanging the queue. `pushed: false`: the base has no upstream, nothing was run.
 * ponytail: a 2-minute timeout holds the merge queue that long on a stalled network; upgrade is a push queue of its own.
 */
export async function push(repo: string): Promise<PushResult> {
  const u = await upstream(repo);
  if (!u) return { ok: true, pushed: false };
  try {
    await run('git', ['push', u.remote, `${u.base}:${u.ref}`], {
      cwd: repo, encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, pushed: true };
  } catch (e) {
    const { stderr, killed } = e as { stderr?: string; killed?: boolean };
    // The reason goes into a note: blank any user:token@ a remote URL carries.
    const reason = killed ? 'git push timed out after 2 minutes' : (stderr ?? '').trim() || (e as Error).message;
    return { ok: false, base: u.base, remote: u.remote, reason: reason.replace(/(\w+:\/\/)[^\s/@]+@/g, '$1***@') };
  }
}
