// The lifecycle end to end on a fake `claude` (board.ts): launch to merge, dependency holds, retries, questions, exits.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { worktreePath } from '../src/git.ts';
import { sessions, sessionsOf } from '../src/launcher.ts';
import { MAX_RETRY, TO_RESOLVE } from '../src/lifecycle.ts';
import { db, git, landed, models, notes, patch, post, repo, runs, send, setRun, sounds, srv, t, ticket, until } from './board.ts';

describe('lifecycle', { timeout: 60_000 }, () => {
  it('launch → execute → test → merge: one plain merge commit by the operator, a done sound then a ding, and nothing left behind', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/events`, { origin: `http://127.0.0.1:${srv.port}`, headers: { cookie: `k95=${srv.secret}` } });
    const frames: { sound?: string; ticket: number | null }[] = [];
    ws.on('message', (m) => frames.push(JSON.parse(String(m))));
    await new Promise((r) => ws.on('open', r));

    const id = ticket('Add the greeting');
    const r = await post(`/api/tickets/${id}/launch`);
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('in_progress');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(409); // already running
    await landed(id);

    expect(t(id)).toMatchObject({ status: 'done', flags: { needs_human: false } });
    expect(runs(id).map((x) => [x.phase, x.outcome])).toEqual([['execute', 'submit'], ['test', 'pass']]);
    const [author, parents, ...message] = git('log', '-1', '--format=%an <%ae>%n%P%n%B').split('\n');
    expect(author).toBe('Op Erator <op@example.com>');
    expect(parents.split(' ')).toHaveLength(2); // --no-ff: a real merge commit
    expect(message.join('\n').trim()).toBe('Add the greeting'); // the title, no ids, no trailers
    expect(git('show', 'HEAD:t-1.txt')).toBe('done');

    // Janitor: no worktree, no branch, no session dir, no live grant for the ticket.
    expect(existsSync(worktreePath(repo, 1))).toBe(false);
    expect(git('branch', '--list', 'ticket/1')).toBe('');
    expect(readdirSync(join(repo, '.kanban95', 'sessions'))).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM grants WHERE ticket_id = ? AND revoked_at IS NULL').get(id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT outcome FROM audit WHERE tool = 'janitor.worktree' AND ticket_id = ?").all(id)).toEqual([{ outcome: 'ok' }]);

    await until(() => frames.some((f) => f.sound === 'ding'), 'the ding frame');
    // The pass sends `done` as it lands in Done, before the merge queue's ding.
    expect(frames.filter((f) => 'sound' in f)).toEqual([{ sound: 'done', ticket: id }, { sound: 'ding', ticket: id }]);
    // A change frame for every transition, so the UI refetches the card instead of reloading.
    expect(frames.filter((f) => !('sound' in f)).length).toBeGreaterThanOrEqual(5);
    expect(frames.every((f) => f.ticket === id)).toBe(true);
    ws.close();
  });

  it('holds a dependent and launches it the moment its last dependency is merged while the runner is on', async () => {
    const b = ticket('Second step');
    const a = ticket('First step');
    db.prepare('INSERT INTO ticket_deps VALUES (?, ?)').run(b, a);
    expect(await (await post(`/api/tickets/${b}/launch`)).json()).toMatchObject({ status: 'backlog', flags: { needs_human: false, blocked_on_deps: true } });
    await post(`/api/tickets/${a}/launch`);
    await setRun(true);
    await landed(a);
    await landed(b);
    expect(runs(b)[0].started_at >= t(a).merged_at!).toBe(true);
    expect(t(b).flags.blocked_on_deps).toBe(false);
  });

  // One merge of `a` for two dependents: `b` stays held, `c`'s wait was cancelled (Cancel wait).
  it('while the runner is off a merged dependency starts nothing: the dependent stays held until Run; Cancel wait clears the hold and keeps retry and notes', async () => {
    const b = ticket('Second step');
    const c = ticket('Second step, not waiting', { retry: 2 });
    const a = ticket('First step');
    for (const id of [b, c]) db.prepare('INSERT INTO ticket_deps VALUES (?, ?)').run(id, a);
    db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'operator', 'decision', 'keep me')").run(c);
    await post(`/api/tickets/${b}/launch`);
    await post(`/api/tickets/${c}/launch`);
    const r = await patch(`/api/tickets/${c}`, { blocked_on_deps: false });
    expect(r.status).toBe(200);
    expect(t(c)).toMatchObject({ status: 'backlog', retry: 2, flags: { blocked_on_deps: false } });
    expect(notes(c, 'decision')).toEqual(['keep me']);
    await post(`/api/tickets/${a}/launch`);
    await landed(a);
    await new Promise((r) => setTimeout(r, 300)); // room for a launch that should not happen
    expect(t(b)).toMatchObject({ status: 'backlog', flags: { blocked_on_deps: true } });
    expect(runs(b)).toEqual([]);
    expect(sessionsOf(b)).toEqual([]);
    expect(t(c).status).toBe('backlog');
    expect(runs(c)).toEqual([]);
    expect((await send('DELETE')(`/api/tickets/${c}`)).status).toBe(204); // checked: out of the way of Run
    await setRun(true);
    expect(t(b).status).toBe('in_progress');
    await landed(b);
  });

  it('retry cap: the first attempt plus exactly three retries, then the operator, and nothing more runs', async () => {
    models({ test: 'fail' });
    const id = ticket('Never quite right');
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human && sessionsOf(id).length === 0, 'the retry cap');
    await new Promise((r) => setTimeout(r, 500));
    expect(runs(id).map((x) => x.phase)).toEqual(['execute', 'test', 'execute', 'test', 'execute', 'test', 'execute', 'test']);
    // The fake tester only calls report_test(false): the report alone ends each test run and sends the ticket back.
    expect(runs(id).filter((x) => x.phase === 'test').map((x) => x.outcome)).toEqual(['fail', 'fail', 'fail', 'fail']);
    expect(t(id)).toMatchObject({ status: 'in_progress', retry: MAX_RETRY + 1, flags: { needs_human: true } });
    expect(sounds).toEqual([{ sound: 'chord', ticket: id }]);
    expect(notes(id, 'failure').at(-1)).toMatch(/^stopped after 4 failed tests\nTo resolve: .*Reset to Backlog and Launch/);
    expect(runs(id)[2].prompt_rendered).toContain('FAIL: criterion 1 fails'); // the retry sees what failed
  });

  it("a tester cannot escalate: its set_model is refused and the retry runs with the ticket's own model", async () => {
    models({ test: 'escalate' });
    const id = ticket('Hard one');
    await post(`/api/tickets/${id}/launch`);
    await until(() => runs(id).filter((x) => x.phase === 'execute').length === 2, 'the retry');
    models({ test: 'pass' });
    await landed(id);
    expect(runs(id).filter((x) => x.phase === 'execute').map((x) => x.model)).toEqual(['work', 'work']);
    expect(t(id)).toMatchObject({ model: null, effort: null, retry: 1 });
  });

  it('ask_operator round trip: chord, the answer reaches the agent as one line and clears the flag', async () => {
    const id = ticket('Paint it', { model: 'ask' });
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).flags.needs_human, 'the question');
    expect(notes(id, 'question')).toEqual(['Which colour?']);
    expect(sounds).toEqual([{ sound: 'chord', ticket: id }]);
    expect(sessionsOf(id)).toHaveLength(1); // the pty stays alive
    const pty = sessionsOf(id)[0].pty, writes: string[] = [], write = pty.write.bind(pty);
    pty.write = (d: string) => { writes.push(d); write(d); };

    expect((await post(`/api/tickets/${id}/answer`, { answer: '  ' })).status).toBe(400);
    const r = await post(`/api/tickets/${id}/answer`, { answer: 'blue,\r\nand bold' });
    expect(r.status).toBe(200);
    expect((await r.json()).flags.needs_human).toBe(false);
    expect(notes(id, 'answer')).toEqual(['blue,\r\nand bold']);
    expect((await post(`/api/tickets/${id}/answer`, { answer: 'again' })).status).toBe(409); // nothing is asked now
    await until(() => writes.length === 2, 'the Enter');
    expect(writes).toEqual(['blue, and bold', '\r']); // Enter on its own, or Claude Code takes the burst as a paste

    await landed(id);
    expect(git('show', 'HEAD:answer.txt')).toBe('blue, and bold');
  });

  it('an agent that exits without reporting, or never starts, cannot leave the ticket unflagged', async () => {
    const silent = ticket('Quiet', { model: 'silent' });
    const broken = ticket('Bad cli', { cli: 'nope' });
    await post(`/api/tickets/${silent}/launch`);
    await post(`/api/tickets/${broken}/launch`);
    await until(() => t(silent).flags.needs_human, 'the silent exit');
    expect(t(silent).status).toBe('in_progress');
    expect(notes(silent, 'failure')).toEqual([`agent exited without reporting\n${TO_RESOLVE}`]);
    expect(runs(silent).map((x) => x.outcome)).toEqual(['exit']);
    expect(t(broken)).toMatchObject({ status: 'in_progress', flags: { needs_human: true } });
    expect(notes(broken, 'failure')[0]).toMatch(/^launch failed: unknown cli nope/);
  });

  it('a ticket whose model is not in the catalog list is flagged at launch with the model named, and no session runs', async () => {
    const file = join(process.env.USERPROFILE!, '.kanban95', 'models.json');
    writeFileSync(file, JSON.stringify({ cli: 'claude', claude: { models: ['work', 'pass'], execute: { model: 'work', effort: 'low' } } }));
    try {
      const id = ticket('Typo model', { model: 'wrok' });
      await post(`/api/tickets/${id}/launch`);
      await until(() => t(id).flags.needs_human, 'the launch failure');
      expect(notes(id, 'failure')[0]).toMatch(/^launch failed: model wrok is not in the claude model list in .*models\.json/);
      expect(sessionsOf(id)).toEqual([]);
    } finally {
      models();
    }
  });

  it("the operator's X ends a session: a ticket's is flagged once with the operator note, a brainstorm's touches no ticket", async () => {
    const del = (key: number) => fetch(`http://127.0.0.1:${srv.port}/api/sessions/${key}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    expect((await del(9999)).status).toBe(404);
    const id = ticket('Long one', { model: 'hang' });
    await post(`/api/tickets/${id}/launch`);
    // Printed first: a pty killed before its fake printed leaves the fake running (board.ts).
    await until(() => sessionsOf(id).length === 1 && sessionsOf(id)[0].scrollback().includes('FAKE'), 'the agent');
    expect((await del(sessionsOf(id)[0].key)).status).toBe(204);
    await until(() => sessionsOf(id).length === 0 && runs(id)[0].outcome, 'the session gone');
    expect(t(id)).toMatchObject({ status: 'in_progress', flags: { needs_human: true } });
    expect(runs(id).map((x) => x.outcome)).toEqual(['closed']);
    await new Promise((r) => setTimeout(r, 200)); // a late exit handler would have written its note by now
    expect(notes(id, 'failure')).toEqual([`ended by the operator from the terminal window
${TO_RESOLVE}`]);
    expect((await post(`/api/tickets/${id}/resume`)).status).toBe(200);

    writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({ cli: 'claude', claude: { plan: { model: 'hang', effort: 'low' } } }));
    const b = await (await post('/api/brainstorm')).json();
    const before = db.prepare('SELECT count(*) n FROM notes').get();
    await until(() => sessions.get(b.id)?.scrollback().includes('FAKE'), 'the brainstorm agent');
    expect((await del(b.id)).status).toBe(204);
    await until(() => !sessions.has(b.id), 'the brainstorm gone');
    expect(db.prepare('SELECT count(*) n FROM notes').get()).toEqual(before);
    expect(db.prepare("SELECT tool, outcome FROM audit WHERE tool = 'sessions.end'").all()).toHaveLength(3);
  });
});
