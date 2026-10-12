// A refused PATCH or DELETE leaves the ticket's agent running; an accepted one ends it once (board.ts fakes `claude`).
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { sessionsOf } from '../src/launcher.ts';
import { db, patch, post, send, t, ticket, until } from './board.ts';

const del = send('DELETE');

async function live(title: string) {
  const id = ticket(title, { model: 'hang' });
  expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
  await until(() => sessionsOf(id)[0]?.scrollback().includes('FAKE'), 'the fake agent to start', 20_000);
  const dependent = ticket(`Needs ${title}`);
  db.prepare('INSERT INTO ticket_deps (ticket_id, depends_on_id) VALUES (?, ?)').run(dependent, id);
  return { id, dependent, s: sessionsOf(id)[0] };
}

const grantRevoked = (grantId: number) => (db.prepare('SELECT revoked_at FROM grants WHERE id = ?').get(grantId) as { revoked_at: string | null }).revoked_at;
const runRow = (runId: number) => db.prepare('SELECT ended_at, outcome FROM runs WHERE id = ?').get(runId);

describe('refused ticket mutations', { timeout: 60_000 }, () => {
  it('a move whose dependency update makes a cycle is refused and leaves the session, grant and run alone', async () => {
    const { id, dependent, s } = await live('Cycle');
    const r = await patch(`/api/tickets/${id}`, { status: 'testing', depends_on: [dependent] });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/dependency cycle/);
    expect(t(id)).toMatchObject({ status: 'in_progress', depends_on: [] });
    expect(sessionsOf(id)).toEqual([s]);
    expect(s.outcome).toBeUndefined();
    expect(grantRevoked(s.grantId)).toBeNull();
    expect(runRow(s.runId!)).toEqual({ ended_at: null, outcome: null });
  });

  it('a move naming a missing dependency is refused and leaves the session alone', async () => {
    const { id, s } = await live('Missing dep');
    expect((await patch(`/api/tickets/${id}`, { status: 'backlog', depends_on: [9999] })).status).toBe(400);
    expect(t(id).status).toBe('in_progress');
    expect(sessionsOf(id)).toEqual([s]);
    expect(s.outcome).toBeUndefined();
    expect(grantRevoked(s.grantId)).toBeNull();
  });

  it('deleting a ticket another depends on is refused without ending its session; once free, the delete ends it', async () => {
    const { id, dependent, s } = await live('Depended on');
    expect((await del(`/api/tickets/${id}`)).status).toBe(400);
    expect(t(id).status).toBe('in_progress');
    expect(sessionsOf(id)).toEqual([s]);
    expect(s.outcome).toBeUndefined();
    expect(grantRevoked(s.grantId)).toBeNull();

    expect((await del(`/api/tickets/${dependent}`)).status).toBe(204);
    expect((await del(`/api/tickets/${id}`)).status).toBe(204);
    expect(s.outcome).toBe('deleted');
    await s.done;
    expect(sessionsOf(id)).toEqual([]);
  });

  it('an accepted move ends the session once, with outcome reset', async () => {
    const { id, s } = await live('Moved');
    expect((await patch(`/api/tickets/${id}`, { status: 'backlog' })).status).toBe(200);
    expect(s.outcome).toBe('reset');
    await s.done;
    expect(sessionsOf(id)).toEqual([]);
    expect(grantRevoked(s.grantId)).not.toBeNull();
    expect(db.prepare('SELECT outcome FROM runs WHERE ticket_id = ?').all(id)).toEqual([{ outcome: 'reset' }]);
  });
});
