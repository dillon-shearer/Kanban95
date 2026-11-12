import './home.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { worktreePath } from '../src/git.ts';
import { git, models, post, repo, runs, send, ticket, until } from './board.ts';

type Progress = { ticket_id: number; started_at: string; output: string };

describe('worktree_setup progress', { timeout: 60_000 }, () => {
  const setup = async (): Promise<Progress[]> => (await (await send('GET')('/api/runner')).json()).setup;

  it('GET /api/runner gives a running setup its start time and its latest output lines, and drops it once the agent starts', async () => {
    writeFileSync(join(repo, 'setup.mjs'), `import { existsSync } from 'node:fs';
for (let i = 1; i <= 5; i++) console.log('step ' + i);
process.stdout.write('\\x1b[32mwarn\\x1b[0m added 506 packages\\r\\n');
while (!existsSync('go')) await new Promise((r) => setTimeout(r, 25));
`);
    git('add', 'setup.mjs');
    git('commit', '-qm', 'Add setup script');
    writeFileSync(join(repo, '.kanban95', 'config.json'), JSON.stringify({ worktree_setup: 'node setup.mjs' }));
    models({ execute: 'silent' });
    const id = ticket('Shows setup progress');
    const before = Date.now();
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);

    let s: Progress[] = [];
    const end = Date.now() + 30_000;
    while (!(s = await setup())[0]?.output.includes('added') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(s).toHaveLength(1);
    expect(s[0].ticket_id).toBe(id);
    expect(Date.parse(s[0].started_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(s[0].started_at)).toBeLessThanOrEqual(Date.now());
    expect(s[0].output).toBe('step 4\nstep 5\nwarn added 506 packages');

    writeFileSync(join(worktreePath(repo, id), 'go'), '');
    await until(() => runs(id).length === 1, 'the agent after setup');
    expect(await setup()).toEqual([]);
  });
});
