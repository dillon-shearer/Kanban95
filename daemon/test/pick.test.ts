import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { finishPick, PICK_MS, startPick, type PickFrame } from '../src/pick.ts';
import { start, startSetup } from '../src/server.ts';
import { normal } from '../src/settings.ts';
import { removeTemp } from './home.ts';

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const other = 'f'.repeat(32);
const lines: string[] = [];
const spy = () => {
  lines.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (lines.push(String(s)), true));
};
afterEach(() => vi.restoreAllMocks());

const client = (port: number, secret: string) => (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `k95=${secret}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('a board', () => {
  const repo = mkdtempSync(join(tmpdir(), 'k95-pick-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  let srv: Awaited<ReturnType<typeof start>>;
  let call: ReturnType<typeof client>;
  let ws: WebSocket;
  const frames: PickFrame[] = [];
  beforeAll(async () => {
    srv = await start({ repo });
    call = client(srv.port, srv.secret);
    ws = new WebSocket(`ws://127.0.0.1:${srv.port}/events`, { origin: `http://127.0.0.1:${srv.port}`, headers: { cookie: `k95=${srv.secret}` } });
    ws.on('message', (m) => {
      const f = JSON.parse(String(m));
      if (f.type === 'pick') frames.push(f);
    });
    await once(ws, 'open');
  }, 30_000);
  afterAll(async () => {
    ws?.close();
    await srv?.close();
    removeTemp(repo);
  });

  it('without a shell answers 409 and prints nothing', async () => {
    srv.board.shell = false;
    spy();
    expect((await call('POST', '/pick', { kind: 'folder' })).status).toBe(409);
    expect(lines).toEqual([]);
  });

  it('under a shell prints pick=, refuses a second request, and sends only the shell\'s answer to /events', async () => {
    srv.board.shell = true;
    spy();
    expect((await call('POST', '/pick', { kind: 'disk' })).status).toBe(400);
    const r = await call('POST', '/pick', { kind: 'folder' });
    expect(r.status).toBe(202);
    const { token } = await r.json();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(lines).toEqual([`KANBAN95 pick=${normal(repo)} folder ${token}\n`]);
    expect((await call('POST', '/pick', { kind: 'file' })).status).toBe(409);
    expect(lines).toHaveLength(1);

    const result = { path: 'C:\\Users\\me\\project' };
    expect((await client(srv.port, 'x'.repeat(64))('POST', `/pick/${token}`, result)).status).toBe(401);
    expect((await call('POST', `/pick/${other}`, result)).status).toBe(404);
    expect((await call('POST', `/pick/${token}`, result, { origin: `http://127.0.0.1:${srv.port}` })).status).toBe(403);
    expect((await call('POST', `/pick/${token}`, { path: '' })).status).toBe(400);
    await wait(200);
    expect(frames).toEqual([]);

    expect((await call('POST', `/pick/${token}`, result)).status).toBe(204);
    await wait(200);
    expect(frames).toEqual([{ type: 'pick', token, ...result }]);
    expect((await call('POST', `/pick/${token}`, result)).status).toBe(404);

    const next = await (await call('POST', '/pick', { kind: 'file' })).json();
    expect((await call('POST', `/pick/${next.token}`, { cancelled: true })).status).toBe(204);
    await wait(200);
    expect(frames.at(-1)).toEqual({ type: 'pick', token: next.token, cancelled: true });
  });
});

describe('the setup page', () => {
  it('starts a pick and polls GET /api/pick/<token> for the result, which it reads once', async () => {
    const srv = await startSetup({ shell: true, done: () => {} });
    const call = client(srv.port, srv.secret);
    try {
      spy();
      const { token } = await (await call('POST', '/pick', { kind: 'file' })).json();
      expect(lines).toEqual([`KANBAN95 pick= file ${token}\n`]);
      expect((await call('POST', '/pick', { kind: 'file' })).status).toBe(409);
      expect(await (await call('GET', `/pick/${token}`)).json()).toEqual({ pending: true });
      expect((await client(srv.port, 'x'.repeat(64))('POST', `/pick/${token}`, { path: '/tmp/a' })).status).toBe(401);
      expect((await call('POST', `/pick/${other}`, { path: '/tmp/a' })).status).toBe(404);
      expect(await (await call('GET', `/pick/${token}`)).json()).toEqual({ pending: true });
      expect((await call('POST', `/pick/${token}`, { path: '/tmp/a' })).status).toBe(204);
      const got = await call('GET', `/pick/${token}`);
      expect([got.status, await got.json()]).toEqual([200, { path: '/tmp/a' }]);
      expect((await call('GET', `/pick/${token}`)).status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it('without a shell answers 409', async () => {
    const srv = await startSetup({ done: () => {} });
    try {
      spy();
      expect((await client(srv.port, srv.secret)('POST', '/pick', { kind: 'folder' })).status).toBe(409);
      expect(lines).toEqual([]);
    } finally {
      await srv.close();
    }
  });
});

it('a pick nobody answers ends as cancelled after PICK_MS and frees the slot', () => {
  vi.useFakeTimers();
  try {
    spy();
    const got: PickFrame[] = [];
    const { body } = startPick(true, '', 'folder', (f) => got.push(f));
    const { token } = body as { token: string };
    expect(startPick(true, '', 'folder').status).toBe(409);
    vi.advanceTimersByTime(PICK_MS);
    expect(got).toEqual([{ type: 'pick', token, cancelled: true }]);
    expect(finishPick(token, undefined, { path: '/tmp/a' }).status).toBe(404);
    expect(startPick(true, '', 'folder').status).toBe(202);
  } finally {
    vi.useRealTimers();
  }
});
