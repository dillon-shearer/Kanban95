import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mint } from '../src/grants.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const clients: Client[] = [];

const ticket = (title: string) => Number(srv.db.prepare("INSERT INTO tickets (title, status) VALUES (?, 'in_progress')").run(title).lastInsertRowid);
const questions = (id: number) => srv.db.prepare("SELECT body FROM notes WHERE ticket_id = ? AND kind = 'question' ORDER BY id").all(id) as { body: string }[];
const inbox = async () => (await (await fetch(`http://127.0.0.1:${srv.port}/api/inbox`, { headers: { cookie: `k95=${srv.secret}` } })).json()) as { ticket_id: number; body: string; permission: unknown }[];

async function session(id: number) {
  const { token } = mint(srv.db, { ticket: id, role: 'worker', ttlMs: 60_000 });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return async (args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: 'request_permission', arguments: args })) as { isError?: boolean; content: { text: string }[] };
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

describe('a request_permission the Inbox no longer shows', () => {
  it('does not block a new request once a relaunch cleared the flag, and the new one is in the Inbox', async () => {
    const id = ticket('relaunched');
    expect((await (await session(id))({ level: 3, reason: 'first session' })).denied).toBe(false);
    srv.db.prepare('UPDATE tickets SET needs_human = 0 WHERE id = ?').run(id);
    expect((await inbox()).some((q) => q.ticket_id === id)).toBe(false);
    expect(await (await session(id))({ level: 3, reason: 'set_model was refused' })).toEqual({ denied: false, text: expect.any(String) });
    expect(questions(id)).toHaveLength(2);
    expect((await inbox()).filter((q) => q.ticket_id === id)).toMatchObject([{ body: 'PERMISSION level=3\nset_model was refused', permission: { level: 3, read_all: false } }]);
  });

  it('does not block a new request once a later failure note replaced it in the Inbox', async () => {
    const id = ticket('exited');
    expect((await (await session(id))({ level: 2, reason: 'first session' })).denied).toBe(false);
    srv.db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'failure', 'exited without reporting')").run(id);
    expect((await (await session(id))({ level: 2, reason: 'again' })).denied).toBe(false);
  });
});
