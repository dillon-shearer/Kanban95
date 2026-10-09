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
