import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/context.ts';
import { mint, type Role } from '../src/grants.ts';
import { OPERATOR_TERMINAL, TYPED } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const clients: Client[] = [];

const ticket = (tags: string) => Number(srv.db.prepare("INSERT INTO tickets (title, status, tags) VALUES ('videos page mockup', 'in_progress', ?)").run(tags).lastInsertRowid);
const row = (id: number) => srv.db.prepare('SELECT status, tags FROM tickets WHERE id = ?').get(id) as { status: string; tags: string };
const note = (id: number, role: string, kind: string, body: string) =>
  srv.db.prepare('INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, ?, ?, ?)').run(id, role, kind, body);
const UNHEARD = 'this ticket is tagged feedback and the operator has not answered a question on it yet';

async function agent(role: Role, ticketId: number | null) {
  const { token } = mint(srv.db, { ticket: ticketId, role, ttlMs: 60_000 });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { denied: r.isError === true, text: r.content[0].text };
  };
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
});
afterAll(async () => {
  for (const c of clients) await c.close();
  await srv.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
});

describe('feedback tickets', () => {
  it('tags a planner ticket feedback when asked, or when its body asks the operator to pick choices and paste them back, and never when told not to', async () => {
    const call = await agent('planner', null);
    const made = async (args: Record<string, unknown>) => row(JSON.parse((await call('create_ticket', { title: 'videos page', ...args })).text).id).tags;
    expect(await made({ body: 'Build a mockup. The owner picks his choices and pastes them back.', tags: ['ui'] })).toBe('ui feedback');
    expect(await made({ body: 'A draft for review.', feedback: true })).toBe('feedback');
    expect(await made({ body: 'Build it with the choices the operator pasted back: dark grid.', feedback: false, tags: ['feedback'] })).toBe('');
    expect(await made({ body: 'Add a videos grid to the page.' })).toBe('');
  });

  it('refuses move_ticket to testing or done until the operator answers, and does not count a permission answer, an operator-terminal answer or a typed one', async () => {
    const id = ticket('feedback');
    const call = await agent('worker', id);
    for (const status of ['testing', 'done']) {
      const r = await call('move_ticket', { status });
      expect(r.denied).toBe(true);
      expect(r.text).toContain(UNHEARD);
    }
    note(id, 'worker', 'question', 'PERMISSION level=2\nneed it');
    note(id, 'operator', 'answer', 'approved');
    note(id, 'worker', 'question', 'open D:\\mockups\\videos.html and paste the choices back');
    note(id, 'operator', 'answer', `${OPERATOR_TERMINAL}: go with the grid`);
    note(id, 'operator', 'answer', TYPED);
    expect((await call('move_ticket', { status: 'testing' })).text).toContain(UNHEARD);
    expect(row(id).status).toBe('in_progress');
  });

  it('keeps the operator answer as an answer note the worker reads, then lets the worker close the ticket with no tester run', async () => {
    const id = ticket('feedback');
    note(id, 'worker', 'question', 'open D:\\mockups\\videos.html and paste the choices back');
    note(id, 'operator', 'answer', 'layout: grid; thumbnails: large [agent level 0, unchanged]');
    const call = await agent('worker', id);
    const notes = JSON.parse((await call('get_ticket')).text).notes as { kind: string; body: string }[];
    expect(notes.filter((n) => n.kind === 'answer').map((n) => n.body)).toEqual(['layout: grid; thumbnails: large [agent level 0, unchanged]']);
    expect(notes.some((n) => n.kind === 'failure')).toBe(false);
    const r = await call('move_ticket', { status: 'done' });
    expect(r.denied).toBe(false);
    expect(row(id).status).toBe('done');
    expect(srv.db.prepare("SELECT count(*) AS n FROM runs WHERE ticket_id = ? AND phase = 'test'").get(id)).toEqual({ n: 0 });
  });

  it('refuses a worker done on a ticket not tagged feedback, and leaves its submit as it was', async () => {
    const id = ticket('ui');
    const call = await agent('worker', id);
    const r = await call('move_ticket', { status: 'done' });
    expect(r).toMatchObject({ denied: true });
    expect(r.text).toBe('a worker may only move its ticket to: testing; ask for level 2 with request_permission');
    expect(row(id).status).toBe('in_progress');
    expect((await call('move_ticket', { status: 'testing' })).text).not.toContain(UNHEARD);
  });

  it('tells the worker in its prompt that the ticket is a feedback ticket', () => {
    const id = ticket('feedback');
    expect(buildContext(srv.db, repo, id, 'worker', {}).ticket).toContain('Tagged feedback');
    expect(buildContext(srv.db, repo, ticket(''), 'worker', {}).ticket).not.toContain('Tagged feedback');
  });
});
