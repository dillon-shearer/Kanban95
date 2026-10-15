import './home.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveOutput } from '../src/output.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let base: string;
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
});

const get = (path: string) => fetch(base + path, { headers: { cookie: `k95=${srv.secret}` } });
const ticket = async (title: string) =>
  (await (await fetch(base + '/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: JSON.stringify({ title }) })).json()) as { id: number };
const run = (ticketId: number, prompt: string, scrollback: string | null) => {
  const id = Number(srv.db.prepare("INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered) VALUES (?, 'execute', 'claude', 'm', 'medium', ?)")
    .run(ticketId, prompt).lastInsertRowid);
  if (scrollback !== null) saveOutput(repo, id, scrollback);
  return id;
};

describe('run list and run detail', () => {
  it('lists runs without the prompt or output, and serves one full run only on its own ticket', async () => {
    const a = await ticket('a');
    const b = await ticket('b');
    const withOut = run(a.id, 'prompt one', 'output one');
    const without = run(a.id, 'prompt two', null);
    const other = run(b.id, 'prompt b', 'output b');

    const list = (await (await get(`/api/tickets/${a.id}/runs`)).json()) as Record<string, unknown>[];
    expect(list.map((r) => r.id)).toEqual([withOut, without]);
    for (const r of list) {
      expect(r).not.toHaveProperty('prompt_rendered');
      expect(r).not.toHaveProperty('scrollback');
    }
    expect(list.map((r) => r.has_scrollback)).toEqual([true, false]);

    expect(await (await get(`/api/tickets/${a.id}/runs/${withOut}`)).json()).toMatchObject({ id: withOut, prompt_rendered: 'prompt one', scrollback: 'output one' });
    expect(await (await get(`/api/tickets/${a.id}/runs/${without}`)).json()).toMatchObject({ prompt_rendered: 'prompt two', scrollback: null });
    expect((await get(`/api/tickets/${a.id}/runs/${other}`)).status).toBe(404);
    expect((await get(`/api/tickets/${a.id}/runs/99999`)).status).toBe(404);
    expect((await get(`/api/tickets/99999/runs/${withOut}`)).status).toBe(404);
  });
});
