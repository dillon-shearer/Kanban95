import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('attachments', () => {
  const upload = (id: number, name: string, data: Buffer | string) =>
    fetch(`${base}/api/tickets/${id}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', body: data, headers: { cookie: `k95=${srv.secret}` } });
  const dir = (id: number) => join(repo, '.kanban95', 'attachments', String(id));

  it('stores, lists, serves and removes a file; a clash gets a new name, never an overwrite', async () => {
    const t = await (await call('POST', '/api/tickets', { title: 'shot' })).json();
    const r = await upload(t.id, 'screen shot.png', 'png-bytes');
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ name: 'screen shot.png', path: join(dir(t.id), 'screen shot.png'), size: 9 });
    expect((await (await upload(t.id, 'screen shot.png', 'other')).json()).name).toBe('screen shot-1.png');
    expect(readFileSync(join(dir(t.id), 'screen shot.png'), 'utf8')).toBe('png-bytes');

    const got = await call('GET', `/api/tickets/${t.id}/attachments/screen%20shot.png`);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(await got.text()).toBe('png-bytes');
    // Anything but an image downloads instead of rendering on the board's origin.
    await upload(t.id, 'page.html', '<script>alert(1)</script>');
    const html = await call('GET', `/api/tickets/${t.id}/attachments/page.html`);
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
    expect(html.headers.get('content-disposition')).toMatch(/^attachment;/);

    expect((await call('DELETE', `/api/tickets/${t.id}/attachments/screen%20shot.png`)).status).toBe(204);
    expect(existsSync(join(dir(t.id), 'screen shot.png'))).toBe(false);
    expect((await (await call('GET', `/api/tickets/${t.id}/attachments`)).json()).map((a: { name: string }) => a.name)).toEqual(['page.html', 'screen shot-1.png']);
    expect((await call('GET', `/api/tickets/${t.id}/attachments/screen%20shot.png`)).status).toBe(404);
    expect(auditRows().filter((a) => a.tool.startsWith('attachments.')).map((a) => [a.tool, a.outcome, a.args_summary])).toEqual([
      ['attachments.add', 'ok', `{"id":${t.id},"name":"screen shot.png"}`],
      ['attachments.add', 'ok', `{"id":${t.id},"name":"screen shot-1.png"}`],
      ['attachments.add', 'ok', `{"id":${t.id},"name":"page.html"}`],
      ['attachments.remove', 'ok', `{"id":${t.id},"name":"screen shot.png"}`],
    ]);
  });

  it('refuses a path separator or .. with 400 and over 10 MB with 413, writing nothing', async () => {
    const t = await (await call('POST', '/api/tickets', { title: 'refusals' })).json();
    for (const name of ['../board.db', '..\\board.db', 'a/b.png', 'a\\b.png', '..', '', 'x..png']) {
      expect((await upload(t.id, name, 'x')).status, name).toBe(400);
    }
    expect((await upload(t.id, 'big.png', Buffer.alloc((10 << 20) + 1))).status).toBe(413);
    expect((await upload(t.id, 'max.png', Buffer.alloc(10 << 20))).status).toBe(201);
    expect((await upload(9999, 'a.png', 'x')).status).toBe(404);
    // Serving and removing refuse an encoded traversal the same way.
    expect((await call('GET', `/api/tickets/${t.id}/attachments/..%5Cboard.db`)).status).toBe(400);
    expect((await call('DELETE', `/api/tickets/${t.id}/attachments/..%2F..%2Fboard.db`)).status).toBe(400);
    expect(readdirSync(dir(t.id))).toEqual(['max.png']);
    expect(existsSync(join(repo, '.kanban95', 'board.db'))).toBe(true);
  });

  it('deleting the ticket removes its attachments directory', async () => {
    const t = await (await call('POST', '/api/tickets', { title: 'gone' })).json();
    await upload(t.id, 'a.png', 'x');
    expect(existsSync(dir(t.id))).toBe(true);
    expect((await call('DELETE', `/api/tickets/${t.id}`)).status).toBe(204);
    expect(existsSync(dir(t.id))).toBe(false);
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

describe('operator preferences', () => {
  const file = () => join(process.env.USERPROFILE!, '.kanban95', 'preferences.md');
  afterAll(() => rmSync(file(), { force: true }));

  it('reads empty when absent, saves the text, refuses over 16 KB without touching the file', async () => {
    rmSync(file(), { force: true });
    expect(await (await call('GET', '/api/config/preferences')).json()).toEqual({ path: file(), value: '' });
    expect((await call('PUT', '/api/config/preferences', { value: 'no em dashes' })).status).toBe(200);
    expect(readFileSync(file(), 'utf8')).toBe('no em dashes');
    expect((await call('PUT', '/api/config/preferences', { value: 'x'.repeat(16 * 1024) })).status).toBe(200);
    const big = await call('PUT', '/api/config/preferences', { value: 'é'.repeat(8 * 1024 + 1) }); // 16 KB + 2 bytes in UTF-8
    expect(big.status).toBe(400);
    expect((await big.json()).error).toMatch(/16 KB/);
    expect(readFileSync(file(), 'utf8')).toBe('x'.repeat(16 * 1024));
    expect((await call('PUT', '/api/config/preferences', { value: 3 })).status).toBe(400);
    expect(existsSync(`${file()}.tmp`)).toBe(false);
  });
});

describe('notepad', () => {
  it('reads empty when absent, saves the whole text, refuses over 256 KB with 413 without touching the file', async () => {
    const file = join(repo, '.kanban95', 'notepad.md');
    expect(await (await call('GET', '/api/notepad')).json()).toEqual({ value: '' });
    expect((await call('PUT', '/api/notepad', { value: 'x'.repeat(256 * 1024) })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe('x'.repeat(256 * 1024));
    const big = await call('PUT', '/api/notepad', { value: 'é'.repeat(128 * 1024 + 1) }); // 256 KB + 2 bytes in UTF-8
    expect(big.status).toBe(413);
    expect((await big.json()).error).toMatch(/256 KB/);
    expect(readFileSync(file, 'utf8')).toBe('x'.repeat(256 * 1024));
    expect((await call('PUT', '/api/notepad', { value: null })).status).toBe(400);
  });
});
