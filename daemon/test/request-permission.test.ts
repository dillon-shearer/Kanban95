import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mint } from '../src/grants.ts';
import { sessions, type Session } from '../src/launcher.ts';
import type { Role } from '../src/grants.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const clients: Client[] = [];

const ticket = (title: string, status = 'in_progress') => Number(srv.db.prepare('INSERT INTO tickets (title, status) VALUES (?, ?)').run(title, status).lastInsertRowid);
const row = (id: number) => srv.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown>;
const notes = (id: number) => srv.db.prepare('SELECT kind, body FROM notes WHERE ticket_id = ? ORDER BY id').all(id) as { kind: string; body: string }[];
const rest = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, { method, headers: { cookie: `k95=${srv.secret}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

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

function fakeSession(ticketId: number) {
  const written: string[] = [];
  const s = { key: -1000 - ticketId, runId: null, grantId: 0, ticketId, role: 'worker', phase: 'execute', started: Date.now(),
    pty: { pid: 0, kill: () => {}, write: (d: string) => { written.push(d); } }, scrollback: () => '' } as unknown as Session;
  sessions.set(s.key, s);
  return { written, end: () => sessions.delete(s.key) };
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

describe('request_permission', () => {
  it('writes a question that starts with the head line, flags the ticket and shows in the Inbox with the parsed request', async () => {
    const id = ticket('needs level 3');
    const call = await agent('worker', id);
    const r = await call('request_permission', { level: 3, reason: 'update_ticket on #9 was refused' });
    expect(r.denied).toBe(false);
    expect(notes(id)).toEqual([{ kind: 'question', body: 'PERMISSION level=3\nupdate_ticket on #9 was refused' }]);
    expect(row(id).needs_human).toBe(1);
    const inbox = (await (await rest('GET', '/inbox')).json()) as { ticket_id: number; permission: unknown }[];
    expect(inbox.find((q) => q.ticket_id === id)?.permission).toEqual({ level: 3, read_all: false });
  });

  it('refuses a second request while one is open, and a level or read_all the ticket already has', async () => {
    const id = ticket('asks twice');
    const call = await agent('tester', id);
    expect((await call('request_permission', { read_all: true, reason: 'first' })).denied).toBe(false);
    expect(await call('request_permission', { level: 2, reason: 'second' })).toEqual({
      denied: true, text: 'an earlier request_permission on this ticket is still unanswered; wait for the operator\x27s answer' });
    srv.db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'operator', 'answer', 'denied')").run(id);
    srv.db.prepare('UPDATE tickets SET agent_level = 3, read_all = 1, needs_human = 0 WHERE id = ?').run(id);
    expect(await call('request_permission', { level: 3, reason: 'again' })).toEqual({ denied: true, text: 'the ticket already has level 3; retry the refused call' });
    expect(await call('request_permission', { level: 2, reason: 'lower' })).toMatchObject({ denied: true });
    expect(await call('request_permission', { read_all: true, reason: 'again' })).toEqual({ denied: true, text: 'the ticket already reads all tickets; retry the refused call' });
    expect(await call('request_permission', { read_all: false, reason: 'nothing' })).toEqual({ denied: true, text: 'give level, read_all: true, or both' });
    expect(notes(id).filter((n) => n.kind === 'question')).toHaveLength(1);
    expect(row(id).needs_human).toBe(0);
  });

  it('is refused to planner and operator grants', async () => {
    const id = ticket('not theirs');
    for (const role of ['planner', 'operator'] as const) {
      const r = await (await agent(role, null))('request_permission', { level: 1, reason: 'x' });
      expect(r).toEqual({ denied: true, text: `${role === 'operator' ? 'an' : 'a'} ${role} may not call request_permission` });
    }
    expect(notes(id)).toEqual([]);
  });

  it('after the operator approves, the same grant\x27s refused call succeeds', async () => {
    const id = ticket('blocked');
    const other = ticket('other', 'in_progress');
    const call = await agent('worker', id);
    const s = fakeSession(id);
    try {
      expect(await call('move_ticket', { ticket_id: other, status: 'backlog' })).toMatchObject({ denied: true, text: expect.stringContaining('ask for level 1 with request_permission') });
      expect((await call('request_permission', { level: 1, reason: 'reset #other' })).denied).toBe(false);
      expect((await rest('PATCH', `/tickets/${id}`, { agent_level: 1 })).status).toBe(200);
      expect((await rest('POST', `/tickets/${id}/answer`, { answer: 'approved: level 1; retry the refused call now' })).status).toBe(200);
      expect(s.written[0]).toBe('approved: level 1; retry the refused call now');
      expect(row(id).needs_human).toBe(0);
      expect((await call('move_ticket', { ticket_id: other, status: 'backlog' })).denied).toBe(false);
      expect(row(other).status).toBe('backlog');
    } finally {
      s.end();
    }
  });
});
