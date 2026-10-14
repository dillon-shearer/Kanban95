import './home.ts';
import { expect, it } from 'vitest';
import { createWorktree } from '../src/git.ts';
import { RESTARTED } from '../src/lifecycle.ts';
import { boot, notes, repo, runs, srv, ticket, until } from './board.ts';

it('a start resumes a running ticket that has a worktree and leaves one without, as a migration sets them, for Launch', { timeout: 60_000 }, async () => {
  const cutOff = ticket('Cut off', { status: 'in_progress' });
  createWorktree(repo, cutOff);
  const imported = [ticket('Imported', { status: 'in_progress' }), ticket('Imported tested', { status: 'testing' })];
  await srv.close();
  await boot();
  await until(() => runs(cutOff).length === 1, 'the cut-off ticket resumed');
  for (const id of imported) {
    expect(runs(id)).toEqual([]);
    expect(notes(id, 'failure')).not.toContain(RESTARTED);
  }
});
