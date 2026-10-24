import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mint } from '../src/grants.ts';
import { sessions, type Session } from '../src/launcher.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const clients: Client[] = [];

const ticket = (title: string) => Number(srv.db.prepare("INSERT INTO tickets (title, status) VALUES (?, 'in_progress')").run(title).lastInsertRowid);
const row = (id: number) => srv.db.prepare('SELECT agent_level, read_all, needs_human FROM tickets WHERE id = ?').get(id) as Record<string, number>;
const lastNote = (id: number) => srv.db.prepare('SELECT kind, body FROM notes WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(id);

async function agent(ticketId: number) {
  const { token } = mint(srv.db, { ticket: ticketId, role: 'worker', ttlMs: 60_000 });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { denied: r.isError === true, text: r.content[0].text };
  };
}

async function terminal(ticketId: number) {
  const s = { key: -1000 - ticketId, runId: null, grantId: 0, ticketId, role: 'worker', phase: 'execute', started: Date.now(),
    pty: { pid: 0, kill: () => {}, write: () => {}, onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }) },
    scrollback: () => '' } as unknown as Session;
  sessions.set(s.key, s);
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/pty/${s.key}`, { origin: `http://127.0.0.1:${srv.port}`, headers: { cookie: `k95=${srv.secret}` } });
  await new Promise((r) => ws.on('open', r));
  const type = async (...chunks: string[]) => {
    const before = JSON.stringify(lastNote(ticketId));
    for (const data of chunks) ws.send(JSON.stringify({ data }));
    for (let i = 0; i < 50 && JSON.stringify(lastNote(ticketId)) === before; i++) await new Promise((r) => setTimeout(r, 20));
  };
  return { type, end: () => { ws.close(); sessions.delete(s.key); } };
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

describe('a permission request answered in the agent\x27s terminal', () => {
  it('approve raises level and read_all as asked, and the refused call then succeeds', async () => {
    const id = ticket('asks');
    const other = ticket('other');
    const call = await agent(id);
    const t = await terminal(id);
    try {
      expect(await call('move_ticket', { ticket_id: other, status: 'backlog' })).toMatchObject({ denied: true, text: expect.stringContaining('ask for level 1') });
      expect((await call('request_permission', { level: 1, read_all: true, reason: 'reset #other' })).denied).toBe(false);
      await t.type('a', 'pprx', '\x7f', 'ove', '\r');
      expect(lastNote(id)).toEqual({ kind: 'answer', body: "approved: level 1, read all (answered in the agent's terminal)" });
      expect(row(id)).toEqual({ agent_level: 1, read_all: 1, needs_human: 0 });
      expect((await call('move_ticket', { ticket_id: other, status: 'backlog' })).denied).toBe(false);
    } finally {
      t.end();
    }
  });

  it('deny, or any other line, closes the question and grants nothing; a level is never lowered', async () => {
    const id = ticket('denied');
    srv.db.prepare('UPDATE tickets SET agent_level = 2 WHERE id = ?').run(id);
    const call = await agent(id);
    const t = await terminal(id);
    try {
      expect((await call('request_permission', { level: 3, reason: 'x' })).denied).toBe(false);
      await t.type('no\r');
      expect(lastNote(id)).toEqual({ kind: 'answer', body: "denied (answered in the agent's terminal)" });
      expect((await call('request_permission', { read_all: true, reason: 'y' })).denied).toBe(false);
      await t.type('let me think\r');
      expect(lastNote(id)).toEqual({ kind: 'answer', body: "answered in the agent's terminal" });
      expect(row(id)).toEqual({ agent_level: 2, read_all: 0, needs_human: 0 });
      expect((await call('request_permission', { read_all: true, reason: 'z' })).denied).toBe(false);
      await t.type('yes\r');
      expect(row(id)).toEqual({ agent_level: 2, read_all: 1, needs_human: 0 });
    } finally {
      t.end();
    }
  });

  it('an approve typed with no open permission request grants nothing', async () => {
    const id = ticket('no request');
    const t = await terminal(id);
    try {
      await t.type('approve\r');
      expect(row(id)).toEqual({ agent_level: 0, read_all: 0, needs_human: 0 });
      expect(lastNote(id)).toBeUndefined();
    } finally {
      t.end();
    }
  });
});
