import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildContext } from '../src/context.ts';
import { mint, revoke } from '../src/grants.ts';
import { start } from '../src/server.ts';

let repo: string;
let outside: string;
let srv: Awaited<ReturnType<typeof start>>;
let worker: { id: number; token: string };

const put = (p: string, text = 'x') => {
  mkdirSync(dirname(join(repo, p)), { recursive: true });
  writeFileSync(join(repo, p), text);
};
const get = (ref: string, token?: string) =>
  fetch(`http://127.0.0.1:${srv.port}/api/context?task_ref=${ref}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const lastAudit = () => srv.db.prepare('SELECT grant_id, ticket_id, tool, outcome FROM audit ORDER BY id DESC LIMIT 1').get();

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-ctx-'));
  outside = mkdtempSync(join(tmpdir(), 'k95-ctx-out-'));
  writeFileSync(join(outside, 'secret.md'), 'x');
  for (const p of ['CONVENTIONS.md', 'knowledge/mcp-tools.md', 'knowledge/gotchas.md', 'parts/bracket/spec.yaml', 'parts/lid/spec.yaml', 'notes.txt']) put(p);
  put('.kanban95/config.json', JSON.stringify({ context: ['CONVENTIONS.md', 'knowledge/*.md'] }));
  srv = await start({ repo });
  srv.db.prepare("INSERT INTO tickets (title, body, criteria, status) VALUES (?, ?, ?, 'in_progress')")
    .run('Model the bracket', 'Build parts/bracket/spec.yaml into a part. See ../secret.md and parts/missing/spec.yaml.', 'Check against CONVENTIONS.md.');
  srv.db.prepare("INSERT INTO tickets (title) VALUES ('other')").run();
  worker = mint(srv.db, { ticket: 1, role: 'worker', ttlMs: 60_000 });
});
afterAll(async () => {
  await srv?.close();
  for (const d of [repo, outside]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

it('a worker bearer, with no shell cookie, gets the config files and the repo paths its ticket names', async () => {
  const r = await get('1', worker.token);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    ticket: { id: 1, title: 'Model the bracket', status: 'in_progress' },
    files: ['CONVENTIONS.md', 'knowledge/gotchas.md', 'knowledge/mcp-tools.md'],
    named: ['CONVENTIONS.md', 'parts/bracket/spec.yaml'],
  });
  expect(lastAudit()).toEqual({ grant_id: worker.id, ticket_id: 1, tool: 'api.context', outcome: 'ok' });
});

it('refuses a missing, unknown or revoked bearer, another ticket, and a bad task_ref', async () => {
  expect((await get('1')).status).toBe(401);
  expect((await get('1', 'nope')).status).toBe(401);
  const r = await get('2', worker.token);
  expect(r.status).toBe(403);
  expect(lastAudit()).toMatchObject({ grant_id: worker.id, ticket_id: 2, outcome: 'denied' });
  expect((await get('abc', worker.token)).status).toBe(400);
  const planner = mint(srv.db, { ticket: null, role: 'planner', ttlMs: 60_000 });
  expect((await get('2', planner.token)).status).toBe(200);
  expect((await get('99', planner.token)).status).toBe(404);
  revoke(srv.db, planner.id);
  expect((await get('2', planner.token)).status).toBe(401);
});

it('a context glob that leaves the repo is a config error, not a listing', async () => {
  put('.kanban95/config.json', JSON.stringify({ context: ['../*/secret.md'] }));
  const r = await get('1', worker.token);
  expect(r.status).toBe(409);
  expect((await r.json()).error).toMatch(/context must be a list of repo-relative paths/);
  put('.kanban95/config.json', JSON.stringify({ context: ['CONVENTIONS.md', 'knowledge/*.md'] }));
});

it('the worker prompt states the context URL for its ticket and port, and how to send the bearer', () => {
  const claude = buildContext(srv.db, repo, 1, 'worker', { port: srv.port, cli: 'claude' }).context;
  expect(claude).toContain(`"http://127.0.0.1:${srv.port}/api/context?task_ref=1"`);
  expect(claude).toContain('auth.header');
  expect(buildContext(srv.db, repo, 1, 'worker', { port: srv.port, cli: 'codex' }).context).toContain('$KANBAN95_TOKEN');
  expect(buildContext(srv.db, repo, null, 'planner', { port: srv.port }).context).toBe('(none)');
});
