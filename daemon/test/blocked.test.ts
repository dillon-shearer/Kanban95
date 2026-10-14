import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { createWorktree } from '../src/git.ts';
import { mint } from '../src/grants.ts';
import { sessionsOf } from '../src/launcher.ts';
import { boot, landed, models, patch, post, runs, setRun, srv, t, ticket, until } from './board.ts';

const settle = () => new Promise((r) => setTimeout(r, 500));

describe('Blocked', { timeout: 60_000 }, () => {
  it('a Blocked backlog ticket is never picked by the runner and its Launch is refused; Unblock starts nothing, then Launch runs it', async () => {
    const id = ticket('Parked');
    expect((await patch(`/api/tickets/${id}`, { blocked: true })).status).toBe(200);
    expect(t(id).flags).toEqual({ needs_human: false, blocked_on_deps: false, blocked: true });
    await setRun(true);
    await settle();
    expect(t(id).status).toBe('backlog');
    expect(runs(id)).toEqual([]);
    const r = await post(`/api/tickets/${id}/launch`);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('cannot launch a Blocked ticket: Unblock it first');
    await setRun(false);
    expect((await patch(`/api/tickets/${id}`, { blocked: false })).status).toBe(200);
    await settle();
    expect(runs(id)).toEqual([]);
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await landed(id);
  });

  it('a Blocked in_progress ticket stays Blocked across a move and a daemon restart, which resumes no agent on it', async () => {
    const id = ticket('Parked mid-run', { status: 'in_progress', blocked: 1 });
    const other = ticket('Running', { status: 'in_progress' });
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(409);
    expect((await post(`/api/tickets/${id}/restart`)).status).toBe(409);
    expect((await patch(`/api/tickets/${id}`, { status: 'testing' })).status).toBe(200);
    expect(t(id)).toMatchObject({ status: 'testing', flags: { blocked: true } });
    await srv.close();
    await boot();
    await until(() => t(other).status === 'done', 'the unblocked ticket resumed by recover to finish');
    expect(t(id)).toMatchObject({ status: 'testing', flags: { blocked: true } });
    expect(runs(id)).toEqual([]);
    expect(sessionsOf(id)).toEqual([]);
  });

  it('a worker that submits while its ticket is Blocked gets no tester; Unblock starts none either', async () => {
    models({ execute: 'ask' });
    const id = ticket('Parked while working');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await until(() => t(id).flags.needs_human, 'the question');
    expect((await patch(`/api/tickets/${id}`, { blocked: true })).status).toBe(200);
    expect((await post(`/api/tickets/${id}/answer`, { answer: 'blue' })).status).toBe(200);
    await until(() => t(id).status === 'testing' && !sessionsOf(id).length, 'the submit');
    expect((await patch(`/api/tickets/${id}`, { blocked: false })).status).toBe(200);
    await settle();
    expect(runs(id).map((r) => r.phase)).toEqual(['execute']);
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await landed(id);
  });

  it('the merge queue skips a Blocked done ticket, on a move into Done and on restart; Retry merge after Unblock lands it', async () => {
    const id = ticket('Parked at the gate', { blocked: 1 });
    const wt = createWorktree(srv.board.repo, id).path;
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    execFileSync('git', ['add', 'b.txt'], { cwd: wt });
    execFileSync('git', ['commit', '-qm', 'Add b'], { cwd: wt });
    expect((await patch(`/api/tickets/${id}`, { status: 'done' })).status).toBe(200);
    expect((await post(`/api/tickets/${id}/merge`)).status).toBe(409);
    await srv.close();
    await boot();
    await settle();
    expect(t(id)).toMatchObject({ status: 'done', merged_at: null, flags: { blocked: true } });
    expect((await patch(`/api/tickets/${id}`, { blocked: false })).status).toBe(200);
    await settle();
    expect(t(id).merged_at).toBeNull();
    expect((await post(`/api/tickets/${id}/merge`)).status).toBe(200);
    await landed(id);
  });

  it('a dependent of a Blocked ticket waits on it as on any unfinished dependency', async () => {
    const dep = ticket('Parked dependency', { blocked: 1 });
    const id = ticket('Dependent');
    srv.db.prepare('INSERT INTO ticket_deps VALUES (?, ?)').run(id, dep);
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    expect(t(id)).toMatchObject({ status: 'backlog', flags: { blocked_on_deps: true, blocked: false } });
  });

  it('update_ticket ignores a blocked field, for a worker and for an operator grant', async () => {
    const id = ticket('Own', { status: 'in_progress' });
    const url = new URL(`http://127.0.0.1:${srv.port}/mcp`);
    for (const g of [mint(srv.db, { ticket: id, role: 'worker', ttlMs: 60_000 }), mint(srv.db, { ticket: null, role: 'operator', ttlMs: 60_000 })]) {
      const c = new Client({ name: 'test', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${g.token}` } } }));
      try {
        for (const blocked of [true, false]) {
          srv.db.prepare('UPDATE tickets SET blocked = ? WHERE id = ?').run(Number(!blocked), id);
          const r = (await c.callTool({ name: 'update_ticket', arguments: { ticket_id: id, body: `edited ${blocked}`, blocked } })) as { isError?: boolean };
          expect(r.isError).toBeFalsy();
          expect(t(id)).toMatchObject({ body: `edited ${blocked}`, flags: { blocked: !blocked } });
        }
      } finally {
        await c.close();
      }
    }
  });
});
