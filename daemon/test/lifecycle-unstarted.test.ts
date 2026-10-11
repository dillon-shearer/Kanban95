// Processes Windows fails to start on a loaded machine (exit 0xC0000142): an agent's CLI in its pty, and the merge queue's git.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { START_RETRY } from '../src/lifecycle.ts';
import { merge } from '../src/merge.ts';
import { git, landed, notes, post, runs, t, ticket, until } from './board.ts';

vi.mock('../src/merge.ts', async (orig) => {
  const real = await orig<typeof import('../src/merge.ts')>();
  return { ...real, merge: vi.fn(real.merge) };
});
// What execFile's promise rejects with when git did not start: Windows' exit status and not a word on either stream.
const notRun = () => Object.assign(new Error('Command failed: git rev-parse --abbrev-ref HEAD'), { code: 3221225794, cmd: 'git rev-parse --abbrev-ref HEAD', stdout: '', stderr: '' });

describe('processes Windows failed to start', { timeout: 60_000 }, () => {
  const retry0 = { ...START_RETRY };
  beforeAll(() => Object.assign(START_RETRY, { every: 100 }));
  afterAll(() => Object.assign(START_RETRY, retry0));

  it('an agent whose CLI never started is started again, unflagged, and its ticket lands', async () => {
    const id = ticket('Write it', { model: 'unstarted-once' });
    await post(`/api/tickets/${id}/launch`);
    await landed(id);
    expect(runs(id).map((r) => [r.phase, r.outcome])).toEqual([['execute', 'unstarted'], ['execute', 'submit'], ['test', 'pass']]);
    expect(notes(id, 'failure')).toEqual([]);
    expect(t(id).flags.needs_human).toBe(false);
  });

  it('an agent that never starts is flagged after START_RETRY.max more tries, saying why', async () => {
    const id = ticket('Write it', { model: 'unstarted' });
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human, 'the flag');
    expect(runs(id).map((r) => r.outcome)).toEqual(['unstarted', 'unstarted', 'unstarted', 'unstarted']);
    expect(notes(id, 'failure')).toEqual([expect.stringMatching(/^agent could not start: Windows failed to start its process 4 times \(0xC0000142\)\nTo resolve: Resume/)]);
    expect(t(id).status).toBe('in_progress');
  });

  it('a merge whose git did not run is tried again and lands, with no conflict sent back', async () => {
    vi.mocked(merge).mockClear().mockRejectedValueOnce(notRun()).mockRejectedValueOnce(notRun());
    const id = ticket('Write it');
    await post(`/api/tickets/${id}/launch`);
    await landed(id);
    expect(merge).toHaveBeenCalledTimes(3);
    expect(t(id)).toMatchObject({ retry: 0, flags: { needs_human: false } });
    expect(notes(id, 'failure')).toEqual([]);
    expect(git('log', '-1', '--format=%s')).toBe('Write it');
  });

  it('a merge whose git never runs is flagged unmerged after START_RETRY.max more tries; Retry merge then lands it', async () => {
    const real = (await vi.importActual<typeof import('../src/merge.ts')>('../src/merge.ts')).merge;
    vi.mocked(merge).mockClear().mockRejectedValue(notRun());
    const id = ticket('Write it');
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human, 'the flag');
    expect(merge).toHaveBeenCalledTimes(4);
    expect(t(id)).toMatchObject({ status: 'done', merged_at: null, retry: 0 });
    expect(notes(id, 'failure')).toEqual([expect.stringMatching(/^merge did not run: git failed to run 4 times: Command failed: git rev-parse[^]*\nTo resolve: check that git runs in the main checkout .*Retry merge\.$/)]);
    vi.mocked(merge).mockImplementation(real);
    expect((await post(`/api/tickets/${id}/merge`)).status).toBe(200);
    await landed(id);
    expect(t(id).flags.needs_human).toBe(false);
  });
});
