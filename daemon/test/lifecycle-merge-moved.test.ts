// The base gets a new commit after the merge queue synced the worktree and before it merges: the operator commits a dirty main.
import './home.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { merge } from '../src/merge.ts';
import { git, landed, post, repo, ticket } from './board.ts';

vi.mock('../src/merge.ts', async (orig) => {
  const real = await orig<typeof import('../src/merge.ts')>();
  return { ...real, merge: vi.fn(real.merge) };
});

describe('lifecycle', { timeout: 180_000 }, () => {
  it('main committed to between the sync and the merge: the new main is merged into the worktree before it lands', async () => {
    const real = (await vi.importActual<typeof import('../src/merge.ts')>('../src/merge.ts')).merge;
    vi.mocked(merge).mockClear().mockImplementationOnce((...a) => {
      writeFileSync(join(repo, 'a.txt'), 'the operator is editing\n');
      git('commit', '-qam', 'Edit a');
      return real(...a);
    });
    const id = ticket('Add behind main');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await landed(id);
    expect(merge).toHaveBeenCalledTimes(2);
    expect(git('log', '-1', '--format=%s', 'HEAD^2')).toBe(`Merge main into ticket/${id}`);
    expect(git('log', '-1', '--format=%s', 'HEAD')).toBe('Add behind main');
    expect(git('show', 'HEAD:a.txt')).toBe('the operator is editing');
  });
});
