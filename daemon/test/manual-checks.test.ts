import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mint, type Role } from '../src/grants.ts';
import { PROMPT_ASK, QUESTION_GONE } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const clients: Client[] = [];

const ticket = (status: string) => Number(srv.db.prepare("INSERT INTO tickets (title, status) VALUES ('https on the pi', ?)").run(status).lastInsertRowid);
const status = (id: number) => (srv.db.prepare('SELECT status FROM tickets WHERE id = ?').get(id) as { status: string }).status;
const note = (id: number, role: string, kind: string, body: string) =>
  srv.db.prepare('INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, ?, ?, ?)').run(id, role, kind, body);
const kinds = (id: number) => (srv.db.prepare('SELECT kind FROM notes WHERE ticket_id = ? ORDER BY id').all(id) as { kind: string }[]).map((n) => n.kind);
const CHECKS = ['open https://pi.example from the phone'];
const REFUSED = `no operator confirmation of the manual checks on this ticket: ${CHECKS[0]}. Ask the operator to make them with ask_operator, wait for the answer, then call again`;

async function agent(role: Role, ticketId: number) {
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

describe('manual checks', () => {
  it('refuses a tester pass with manual checks and no operator answer, leaving the ticket in testing and no note', async () => {
    const id = ticket('testing');
    const call = await agent('tester', id);
    expect(await call('report_test', { passed: true, summary: 'already on master', manual_checks: CHECKS })).toEqual({ denied: true, text: REFUSED });
    expect(status(id)).toBe('testing');
    expect(kinds(id)).toEqual([]);
  });

  it('does not count an answered permission request, a Claude Code prompt or a question closed by a restart as confirmation', async () => {
    const id = ticket('testing');
    note(id, 'tester', 'question', 'PERMISSION level=2\nneed it');
    note(id, 'operator', 'answer', 'approved');
    note(id, 'tester', 'question', `${PROMPT_ASK}\n\`\`\`\n1. Yes\n\`\`\``);
    note(id, 'operator', 'answer', '1');
    note(id, 'tester', 'question', 'did the phone load the page?');
    note(id, 'tester', 'answer', QUESTION_GONE);
    const call = await agent('tester', id);
    expect(await call('report_test', { passed: true, summary: 'ok', manual_checks: CHECKS })).toEqual({ denied: true, text: REFUSED });
    expect(status(id)).toBe('testing');
  });

  it('lets a tester fail with manual checks and no answer, naming the missing check', async () => {
    const id = ticket('testing');
    const call = await agent('tester', id);
    expect((await call('report_test', { passed: false, summary: 'needs the phone check', manual_checks: CHECKS })).denied).toBe(false);
    expect(status(id)).toBe('in_progress');
  });

  it('passes the gate once the operator answered an ask_operator question', async () => {
    const id = ticket('testing');
    note(id, 'tester', 'question', 'open https://pi.example from the phone: does it load with a valid cert?');
    note(id, 'operator', 'answer', 'yes, loads, padlock shown');
    const call = await agent('tester', id);
    const r = await call('report_test', { passed: true, summary: 'confirmed by the operator', manual_checks: CHECKS });
    expect(r.text).not.toContain('no operator confirmation');
    expect(kinds(id)).toContain('summary');
  });

  it('refuses a worker submit with manual checks until the operator answered, before any lifecycle move', async () => {
    const id = ticket('in_progress');
    const call = await agent('worker', id);
    expect(await call('move_ticket', { status: 'testing', manual_checks: CHECKS })).toEqual({ denied: true, text: REFUSED });
    expect(status(id)).toBe('in_progress');
    note(id, 'worker', 'question', 'please open https://pi.example from the phone');
    note(id, 'operator', 'answer', 'works');
    expect((await call('move_ticket', { status: 'testing', manual_checks: CHECKS })).text).not.toContain('no operator confirmation');
  });

  it('leaves a move or a pass without manual checks as it was', async () => {
    const id = ticket('testing');
    const call = await agent('tester', id);
    expect((await call('report_test', { passed: true, summary: 'unit-only ticket' })).text).not.toContain('no operator confirmation');
  });
});
