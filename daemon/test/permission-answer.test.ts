import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mint } from '../src/grants.ts';
import { sessions, type Session } from '../src/launcher.ts';
import { PENDING, RAISE_ASK } from '../src/mcp.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const clients: Client[] = [];

const ticket = (title: string) => Number(srv.db.prepare("INSERT INTO tickets (title, status) VALUES (?, 'in_progress')").run(title).lastInsertRowid);
const row = (id: number) => srv.db.prepare('SELECT agent_level, read_all, needs_human FROM tickets WHERE id = ?').get(id) as Record<string, number>;
const lastNote = (id: number) => srv.db.prepare('SELECT kind, body FROM notes WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(id);
const note = (id: number, kind: string, body: string) =>
  Number(srv.db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', ?, ?)").run(id, kind, body).lastInsertRowid);
const answer = (id: number, text: string) =>
  fetch(`http://127.0.0.1:${srv.port}/api/tickets/${id}/answer`, { method: 'POST', headers: { cookie: `k95=${srv.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ answer: text }) });

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

function terminal(ticketId: number) {
  const typed: string[] = [];
  const s = { key: -2000 - ticketId, runId: null, grantId: 0, ticketId, role: 'worker', phase: 'execute', started: Date.now(),
    pty: { pid: 0, kill: () => {}, write: (d: string) => typed.push(d), onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }) },
    scrollback: () => '' } as unknown as Session;
  sessions.set(s.key, s);
  return { typed, end: () => sessions.delete(s.key) };
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

describe('a level raise asked or approved outside request_permission', () => {
  it('refuses an ask_operator question asking to raise the agent level, pointing at request_permission', async () => {
    const id = ticket('asks by question');
    const call = await agent(id);
    expect(await call('ask_operator', { question: 'Please raise #5 to agent level 3 so set_model works, reply done. a) yes b) no' })).toEqual({ denied: true, text: RAISE_ASK });
    expect(await call('ask_operator', { question: 'Can you turn on read_all for this ticket?' })).toMatchObject({ denied: false });
    expect(row(id).needs_human).toBe(1);
  });

  it('refuses an ask_operator question while the ticket\x27s own request_permission waits for the operator', async () => {
    const id = ticket('asks twice');
    const call = await agent(id);
    expect((await call('request_permission', { level: 3, read_all: true, reason: 'set_model was refused' })).denied).toBe(false);
    expect(await call('ask_operator', { question: '(a) Approve question 35 (b) set it by hand' })).toEqual({ denied: true, text: PENDING });
    expect(lastNote(id)).toMatchObject({ kind: 'question', body: expect.stringMatching(/^PERMISSION level=3 read_all=1\n/) });
  });

  it('an approval of a question asked behind a pending request_permission approves it, and the agent is told the new level', async () => {
    const id = ticket('older daemon');
    const t = terminal(id);
    try {
      const asked = note(id, 'question', 'PERMISSION level=3 read_all=1\nset_model was refused');
      note(id, 'question', '(a) Approve question 35 (b) set it by hand');
      srv.db.prepare('UPDATE tickets SET needs_human = 1 WHERE id = ?').run(id);
      expect((await answer(id, 'A approve; request on its own after this')).status).toBe(200);
      const said = `A approve; request on its own after this [approved request_permission ${asked}: agent level 3, read all now, was agent level 0; retry the refused call now]`;
      expect(lastNote(id)).toEqual({ kind: 'answer', body: said });
      expect(t.typed[0]).toBe(said);
      expect(row(id)).toEqual({ agent_level: 3, read_all: 1, needs_human: 0 });
    } finally {
      t.end();
    }
  });

  it('a non-approval, or a request from before the current run, grants nothing and says the level is unchanged', async () => {
    const id = ticket('not approved');
    const t = terminal(id);
    try {
      note(id, 'question', 'PERMISSION level=2\nmove refused');
      note(id, 'question', 'which file?');
      srv.db.prepare('UPDATE tickets SET needs_human = 1 WHERE id = ?').run(id);
      await answer(id, 'a quick look says api.ts');
      expect(lastNote(id)).toEqual({ kind: 'answer', body: 'a quick look says api.ts [agent level 0, unchanged]' });

      note(id, 'question', 'PERMISSION level=2\nmove refused');
      srv.db.prepare("INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered, started_at) VALUES (?, 'execute', 'claude', 'm', 'low', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 second'))").run(id);
      note(id, 'question', 'ready?');
      srv.db.prepare('UPDATE tickets SET needs_human = 1 WHERE id = ?').run(id);
      await answer(id, 'yes');
      expect(lastNote(id)).toEqual({ kind: 'answer', body: 'yes [agent level 0, unchanged]' });
      expect(row(id)).toEqual({ agent_level: 0, read_all: 0, needs_human: 0 });
    } finally {
      t.end();
    }
  });

  it('the Inbox\x27s Approve and Deny of a permission request say the level the ticket now has', async () => {
    const id = ticket('inbox approve');
    const t = terminal(id);
    try {
      const call = await agent(id);
      expect((await call('request_permission', { level: 1, reason: 'reset another ticket' })).denied).toBe(false);
      srv.db.prepare('UPDATE tickets SET agent_level = 1 WHERE id = ?').run(id);
      await answer(id, 'approved: level 1; retry the refused call now');
      expect(lastNote(id)).toEqual({ kind: 'answer', body: 'approved: level 1; retry the refused call now [agent level 1 now]' });
      expect((await call('request_permission', { level: 2, reason: 'done without tester' })).denied).toBe(false);
      await answer(id, 'denied');
      expect(lastNote(id)).toEqual({ kind: 'answer', body: 'denied [agent level 1, unchanged]' });
    } finally {
      t.end();
    }
  });
});
