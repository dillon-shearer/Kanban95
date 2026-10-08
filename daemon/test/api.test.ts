import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mint, verify } from '../src/grants.ts';
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

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const auditRows = () => srv.db.prepare('SELECT tool, outcome, ticket_id, grant_id, args_summary FROM audit ORDER BY id').all();

describe('origin guard', () => {
  it('refuses a foreign Origin and a foreign Host, allows its own', async () => {
    expect((await call('GET', '/api/tickets', undefined, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('GET', '/api/tickets', undefined, { origin: `http://localhost:${srv.port}` })).status).toBe(403);
    // fetch strips a caller-set Host header, so this one goes through node:http.
    const foreignHost = await new Promise<number>((ok, fail) =>
      request({ host: '127.0.0.1', port: srv.port, path: '/health', headers: { host: 'attacker.example' } }, (r) => ok(r.statusCode!))
        .on('error', fail)
        .end(),
    );
    expect(foreignHost).toBe(403);
    expect((await call('GET', '/api/tickets', undefined, { origin: base })).status).toBe(200);
    expect((await call('GET', '/api/tickets')).status).toBe(200);
  });
});

describe('tickets', () => {
  it('creates, reads, updates, lists and deletes, auditing every mutation', async () => {
    const created = await call('POST', '/api/tickets', { title: 'first', criteria: 'works', effort: 'low' });
    expect(created.status).toBe(201);
    const t = await created.json();
    expect(t).toMatchObject({ id: 1, title: 'first', status: 'backlog', effort: 'low', retry: 0, depends_on: [] });
    expect(t.flags).toEqual({ needs_human: false, blocked_on_deps: false });

    const patched = await call('PATCH', '/api/tickets/1', { status: 'in_progress', needs_human: true, effort: null });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ status: 'in_progress', effort: null, flags: { needs_human: true, blocked_on_deps: false } });

    expect((await (await call('GET', '/api/tickets')).json()).length).toBe(1);
    expect((await call('GET', '/api/tickets/1')).status).toBe(200);
    expect((await call('GET', '/api/tickets/99')).status).toBe(404);
    expect((await call('DELETE', '/api/tickets/1')).status).toBe(204);
    expect((await call('DELETE', '/api/tickets/1')).status).toBe(404);

    expect(auditRows()).toEqual([
      { tool: 'tickets.create', outcome: 'ok', ticket_id: null, grant_id: null, args_summary: expect.stringContaining('"title":"first"') },
      { tool: 'tickets.update', outcome: 'ok', ticket_id: null, grant_id: null, args_summary: expect.stringContaining('"id":1') },
      { tool: 'tickets.delete', outcome: 'ok', ticket_id: null, grant_id: null, args_summary: '{"id":1}' },
      { tool: 'tickets.delete', outcome: 'error', ticket_id: null, grant_id: null, args_summary: '{"id":1}' },
    ]);
    // ticket_id is null above because the ticket was deleted and audit.ticket_id is ON DELETE SET NULL.
  });

  it('rejects bad input at the boundary and audits the attempt', async () => {
    const before = auditRows().length;
    expect((await call('POST', '/api/tickets', { body: 'no title' })).status).toBe(400);
    expect((await call('POST', '/api/tickets', { title: '' })).status).toBe(400);
    expect((await call('POST', '/api/tickets', { title: 'x', status: 'review' })).status).toBe(400);
    expect((await call('POST', '/api/tickets', { title: 'x', effort: 'ultra' })).status).toBe(400);
    expect((await call('POST', '/api/tickets', { title: 'x', bogus: 1 })).status).toBe(400);
    expect((await call('POST', '/api/tickets', { title: 42 })).status).toBe(400);
    expect((await call('POST', '/api/tickets', [1])).status).toBe(400);
    expect((await fetch(base + '/api/tickets', { method: 'POST', body: '{nope', headers: { cookie: `k95=${srv.secret}` } })).status).toBe(400);
    expect((await call('PUT', '/api/tickets')).status).toBe(405);
    expect((await call('GET', '/api/nothing')).status).toBe(404);
    expect(auditRows().slice(before).every((r) => r.outcome === 'error')).toBe(true);
    expect(auditRows().length).toBe(before + 8);
  });

  it('depends_on must name existing tickets and is returned sorted', async () => {
    const a = await (await call('POST', '/api/tickets', { title: 'a' })).json();
    const b = await (await call('POST', '/api/tickets', { title: 'b' })).json();
    const bad = await call('POST', '/api/tickets', { title: 'c', depends_on: [a.id, 9999] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/FOREIGN KEY/);
    expect((await (await call('GET', '/api/tickets')).json()).map((t: { title: string }) => t.title)).toEqual(['a', 'b']);

    const c = await (await call('POST', '/api/tickets', { title: 'c', depends_on: [b.id, a.id] })).json();
    expect(c.depends_on).toEqual([a.id, b.id]);
    expect((await call('PATCH', `/api/tickets/${c.id}`, { depends_on: [c.id] })).status).toBe(400);
    expect((await call('DELETE', `/api/tickets/${a.id}`)).status).toBe(400); // still depended on
    const cleared = await (await call('PATCH', `/api/tickets/${c.id}`, { depends_on: [] })).json();
    expect(cleared.depends_on).toEqual([]);
  });

  it('lists notes, runs and audit per ticket', async () => {
    const t = await (await call('POST', '/api/tickets', { title: 'n' })).json();
    srv.db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', 'plan', 'do it')").run(t.id);
    srv.db
      .prepare("INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered) VALUES (?, 'execute', 'claude', 'm', 'medium', 'p')")
      .run(t.id);
    expect(await (await call('GET', `/api/tickets/${t.id}/notes`)).json()).toMatchObject([{ kind: 'plan', body: 'do it' }]);
    expect(await (await call('GET', `/api/tickets/${t.id}/runs`)).json()).toMatchObject([{ phase: 'execute', outcome: null }]);
    expect(await (await call('GET', `/api/tickets/${t.id}/audit`)).json()).toMatchObject([{ tool: 'tickets.create', outcome: 'ok' }]);
    expect((await call('GET', `/api/tickets/9999/notes`)).status).toBe(404);
  });
});

describe('brain', () => {
  it('ranks FTS matches, caps the limit, and survives hostile query syntax', async () => {
    const ins = srv.db.prepare('INSERT INTO brain (title, body, tags) VALUES (?, ?, ?)');
    ins.run('worktree cleanup', 'remove the worktree after merge', 'git');
    ins.run('merge queue', 'merges are serialized', 'git');
    ins.run('unrelated', 'nothing here', '');
    const hits = await (await call('GET', '/api/brain?q=worktree')).json();
    expect(hits.map((h: { title: string }) => h.title)).toEqual(['worktree cleanup']);
    expect((await (await call('GET', '/api/brain?q=git&limit=1')).json()).length).toBe(1);
    expect((await call('GET', '/api/brain?q=' + encodeURIComponent('"unbalanced OR (x'))).status).toBe(200);
    expect((await (await call('GET', '/api/brain')).json()).length).toBe(3);
  });
});

describe('grants over REST', () => {
  it('lists grants without hashes and revokes them, audited', async () => {
    const t = await (await call('POST', '/api/tickets', { title: 'g' })).json();
    const { id, token } = mint(srv.db, { ticket: t.id, role: 'worker', ttlMs: 60_000 });
    const list = await (await call('GET', '/api/grants')).json();
    const mine = list.find((g: { id: number }) => g.id === id);
    expect(mine).toMatchObject({ ticket_id: t.id, role: 'worker', revoked_at: null });
    expect(JSON.stringify(list)).not.toMatch(/token/);

    expect((await call('DELETE', `/api/grants/${id}`)).status).toBe(204);
    expect(verify(srv.db, token)).toBeNull();
    expect((await call('DELETE', `/api/grants/${id}`)).status).toBe(404);
    expect(auditRows().slice(-2)).toMatchObject([
      { tool: 'grants.revoke', outcome: 'ok', args_summary: `{"id":${id}}` },
      { tool: 'grants.revoke', outcome: 'error' },
    ]);
  });
});

describe('model lists for the Settings dropdowns', () => {
  const home = process.env.USERPROFILE!;
  const cache = join(home, '.codex', 'models_cache.json');
  beforeAll(() => {
    // node --help has no Claude Code alias line, so the claude list is empty and the test never runs the real CLI.
    mkdirSync(join(home, '.kanban95'), { recursive: true });
    writeFileSync(join(home, '.kanban95', 'settings.json'), JSON.stringify({ paths: { claude: process.execPath } }));
    mkdirSync(join(home, '.codex'), { recursive: true });
  });
  afterAll(() => rmSync(join(home, '.kanban95', 'settings.json'), { force: true }));

  it('lists every Codex model, hidden ones too, in its order', async () => {
    writeFileSync(cache, JSON.stringify({ models: [
      { slug: 'b', visibility: 'list', priority: 5 }, { slug: 'hidden', visibility: 'hide', priority: 1 }, { slug: 'a', visibility: 'list', priority: 2 },
    ] }));
    expect(await (await call('GET', '/api/models')).json()).toEqual({ claude: [], codex: ['hidden', 'a', 'b'] });
  });

  it('lists the model ids inside the Claude executable newest first, without beta headers', async () => {
    // Not runnable, so --help gives no aliases; the 4 MB of padding puts one id across a read-chunk boundary.
    const exe = join(home, 'fake-claude.exe');
    const pad = 'x'.repeat((4 << 20) - 10);
    writeFileSync(exe, `claude-code-20250219 claude-opus-4-1-20250805 claude-opus-4-1 ${pad}claude-sonnet-4-5 claude-opus-4-10 claude-eval-9`);
    writeFileSync(join(home, '.kanban95', 'settings.json'), JSON.stringify({ paths: { claude: exe } }));
    expect((await (await call('GET', '/api/models')).json()).claude)
      .toEqual(['claude-opus-4-10', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-opus-4-1-20250805']);
    writeFileSync(join(home, '.kanban95', 'settings.json'), JSON.stringify({ paths: { claude: process.execPath } }));
  });

  it('answers empty lists when the cache is missing or unreadable', async () => {
    writeFileSync(cache, '{not json');
    expect(await (await call('GET', '/api/models')).json()).toEqual({ claude: [], codex: [] });
    rmSync(cache);
    expect(await (await call('GET', '/api/models')).json()).toEqual({ claude: [], codex: [] });
  });
});
