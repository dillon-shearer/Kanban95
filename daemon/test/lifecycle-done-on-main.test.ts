// A ticket whose work another ticket already landed: the worker submits an empty branch with its evidence in a decision note,
// the tester sees that note, and the ticket reaches done with no operator action.
import './home.ts';
import { describe, expect, it } from 'vitest';
import { git, landed, models, post, runs, t, ticket } from './board.ts';

describe('lifecycle', { timeout: 180_000 }, () => {
  it('an empty diff with the work on main: the decision note reaches the tester and the ticket lands', async () => {
    models({ execute: 'done-on-main' });
    const id = ticket('Already done');
    const head = git('rev-parse', 'HEAD');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await landed(id);
    expect(t(id)).toMatchObject({ status: 'done', retry: 0, flags: { needs_human: false } });
    expect(runs(id).map((x) => [x.phase, x.outcome])).toEqual([['execute', 'submit'], ['test', 'pass']]);
    const prompt = runs(id)[1].prompt_rendered;
    expect(prompt).toContain('- [worker decision] already on main: init');
    expect(prompt).toMatch(/```diff\n\(none\)\n```/);
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });
});
