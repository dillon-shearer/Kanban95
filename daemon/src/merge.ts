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

export type MergeResult = { ok: true } | { ok: false; reason: string };

/**
 * `git merge --no-ff ticket/<id>` into whatever branch the main working tree has checked out, authored by the repo's own
 * git identity. The message is the ticket title, one line, nothing appended. Any failure is aborted, leaving the base as it was.
 */
export async function merge(repo: string, ticketId: number, title: string): Promise<MergeResult> {
  const { stdout: dirty } = await git(repo, 'status', '--porcelain', '--untracked-files=no');
  if (dirty.trim()) return { ok: false, reason: `the base working tree has uncommitted changes:\n${dirty.trimEnd()}` };
  try {
    await git(repo, 'merge', '--no-ff', '--no-edit', '-m', title.split(/\r?\n/)[0].trim(), branchName(ticketId));
    return { ok: true };
  } catch (e) {
    await git(repo, 'merge', '--abort').catch(() => {}); // nothing to abort when the merge never started
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    return { ok: false, reason: `${stdout ?? ''}${stderr ?? ''}`.trim() || (e as Error).message };
  }
}
