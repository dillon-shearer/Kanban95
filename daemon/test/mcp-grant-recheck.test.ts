import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mint, revoke } from '../src/grants.ts';
import { start } from '../src/server.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const notes = () => (srv.db.prepare('SELECT count(*) AS n FROM notes WHERE ticket_id = 1').get() as { n: number }).n;
const lastAudit = () => srv.db.prepare('SELECT grant_id, tool, args_summary, outcome FROM audit ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function delayedCall(token: string, name: string, args: Record<string, unknown>, between: () => Promise<void>) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let entered = false;
  const res = new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: srv.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
        },
      },
      (r) => {
        let text = '';
        r.on('data', (d) => (text += d));
        r.on('end', () => resolve({ status: r.statusCode!, text }));
      },
    );
    req.on('error', reject);
    req.write(body.slice(0, 1), () => (entered = true));
    void (async () => {
      while (!entered) await wait(5);
      await wait(50);
      await between();
      req.end(body.slice(1));
    })();
  });
  return res;
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  srv.db.prepare("INSERT INTO tickets (title) VALUES ('secret title')").run();
});
afterAll(async () => {
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('grant recheck at dispatch', () => {
  it('runs a live call whose body arrives late', async () => {
    const g = mint(srv.db, { ticket: 1, role: 'worker', ttlMs: 60_000 });
    const before = notes();
    const r = await delayedCall(g.token, 'add_note', { kind: 'decision', body: 'live' }, async () => {});
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).result.isError).toBeUndefined();
    expect(notes()).toBe(before + 1);
  });

  it('refuses a mutation when the grant is revoked before the body completes', async () => {
    const g = mint(srv.db, { ticket: 1, role: 'worker', ttlMs: 60_000 });
    const before = notes();
    const r = await delayedCall(g.token, 'add_note', { kind: 'decision', body: 'late' }, async () => void revoke(srv.db, g.id));
    const result = JSON.parse(r.text).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/revoked or has expired/);
    expect(notes()).toBe(before);
    const a = lastAudit();
    expect(a).toMatchObject({ grant_id: g.id, tool: 'add_note', outcome: 'denied' });
    expect(String(a.args_summary)).not.toContain(g.token);
  });

  it('refuses a read when the grant expires before the body completes', async () => {
    const g = mint(srv.db, { ticket: 1, role: 'worker', ttlMs: 300 });
    const r = await delayedCall(g.token, 'get_ticket', {}, () => wait(400));
    const result = JSON.parse(r.text).result;
    expect(result.isError).toBe(true);
    expect(r.text).not.toContain('secret title');
    expect(lastAudit()).toMatchObject({ grant_id: g.id, tool: 'get_ticket', outcome: 'denied' });
  });
});
