import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { mint } from '../src/grants.ts';
import { sessionsOf } from '../src/launcher.ts';
import { db, models, post, runs, srv, t, ticket, until } from './board.ts';

describe('operator move_ticket to backlog', { timeout: 60_000 }, () => {
  it('parks a running ticket waiting on a question: its agent ends, needs_human clears, retry resets', async () => {
    models({ execute: 'ask' });
    const id = ticket('Waiting on the operator', { retry: 2 });
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await until(() => t(id).flags.needs_human, 'the question');
    const [s] = sessionsOf(id);
    const op = new Client({ name: 'test', version: '0' });
    const { token } = mint(db, { ticket: null, role: 'operator', ttlMs: 60_000 });
    await op.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const r = (await op.callTool({ name: 'move_ticket', arguments: { ticket_id: id, status: 'backlog' } })) as { isError?: boolean };
    await op.close();
    expect(r.isError).toBeFalsy();
    expect(t(id)).toMatchObject({ status: 'backlog', retry: 0, flags: { needs_human: false, blocked_on_deps: false } });
    expect(s.outcome).toBe('reset');
    await s.done;
    expect(sessionsOf(id)).toEqual([]);
    expect(runs(id).map((x) => x.outcome)).toEqual(['reset']);
  });
});
