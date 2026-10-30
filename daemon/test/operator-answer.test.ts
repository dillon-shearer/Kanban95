import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mint, type Role } from '../src/grants.ts';
import { PROMPT_ASK } from '../src/lifecycle.ts';
import { OPERATOR_TERMINAL } from '../src/mcp.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const clients: Client[] = [];

const ticket = (status: string) => Number(srv.db.prepare("INSERT INTO tickets (title, status) VALUES ('t', ?)").run(status).lastInsertRowid);
const row = (id: number) => srv.db.prepare('SELECT status, needs_human FROM tickets WHERE id = ?').get(id) as { status: string; needs_human: number };
const notes = (id: number) => srv.db.prepare('SELECT role, kind, body FROM notes WHERE ticket_id = ? ORDER BY id').all(id) as { role: string; kind: string; body: string }[];
const UNANSWERED = 'cannot submit a ticket in in_progress: your question to the operator is not answered yet; wait for the answer in this terminal, then move the ticket';

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

describe('operator terminal answers an ask_operator question', () => {
  it('records an answer naming the operator terminal, and the worker may then submit', async () => {
    const id = ticket('in_progress');
    const worker = await agent('worker', id);
    expect((await worker('ask_operator', { question: 'split into follow-ups or keep one ticket?' })).denied).toBe(false);
    expect(await worker('move_ticket', { status: 'testing' })).toEqual({ denied: true, text: UNANSWERED });

    const op = await agent('operator', null);
    expect((await op('answer_question', { ticket_id: id, answer: 'split it' })).denied).toBe(false);
    const last = notes(id).filter((n) => n.kind === 'answer').at(-1)!;
    expect(last.role).toBe('operator');
    expect(last.body.startsWith(`${OPERATOR_TERMINAL}: split it`)).toBe(true);

    expect((await worker('move_ticket', { status: 'testing' })).text).not.toBe(UNANSWERED);
    expect(row(id).status).not.toBe('in_progress');
  });

  it('refuses a ticket with no open question, a permission request and a Claude Code prompt', async () => {
    const op = await agent('operator', null);
    const id = ticket('in_progress');
    expect(await op('answer_question', { ticket_id: id, answer: 'yes' })).toEqual({ denied: true, text: `ticket ${id} has no open question to answer` });

    for (const body of ['PERMISSION level=4\nneed it', `${PROMPT_ASK}\n1. Yes`]) {
      const t = ticket('in_progress');
      srv.db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'question', ?)").run(t, body);
      srv.db.prepare('UPDATE tickets SET needs_human = 1 WHERE id = ?').run(t);
      const r = await op('answer_question', { ticket_id: t, answer: 'yes' });
      expect(r.denied, body).toBe(true);
      expect(row(t).needs_human).toBe(1);
      expect(notes(t).map((n) => n.kind)).toEqual(['question']);
    }
  });

  it('does not count as confirmation of manual checks', async () => {
    const id = ticket('in_progress');
    const worker = await agent('worker', id);
    await worker('ask_operator', { question: 'please open the page on the phone' });
    const op = await agent('operator', null);
    await op('answer_question', { ticket_id: id, answer: 'it loads' });
    expect((await worker('move_ticket', { status: 'testing', manual_checks: ['open the page on the phone'] })).text).toContain('no operator confirmation');
  });

  it('lets no agent answer its own ticket at level 4', async () => {
    const id = ticket('in_progress');
    srv.db.prepare('UPDATE tickets SET agent_level = 4 WHERE id = ?').run(id);
    const worker = await agent('worker', id);
    await worker('ask_operator', { question: 'which way?' });
    expect(await worker('answer_question', { ticket_id: id, answer: 'mine' })).toEqual({ denied: true, text: "an agent may not answer its own ticket's question" });
    expect(row(id).needs_human).toBe(1);
  });
});
