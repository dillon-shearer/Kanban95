import './home.ts';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import { start } from '../src/server.ts';
import { removeTemp } from './home.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let base: string;
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-open-failed-'));
  srv = await start({ repo, shell: true });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  removeTemp(repo);
});

const report = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/open/shell`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}`, ...headers }, body: JSON.stringify(body) });

it("the shell's report of a board that did not open reaches /events with the folder name and the reason on one line", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/events`, { origin: base, headers: { cookie: `k95=${srv.secret}` } });
  await once(ws, 'open');
  const heard = new Promise((ok) => ws.on('message', (m) => {
    const e = JSON.parse(String(m));
    if (e.type === 'open-failed') ok(e);
  }));
  const error = "The Kanban95 daemon did not say its port within 20s.\n\nCheck the console for the daemon's error.";
  expect((await report({ path: join(tmpdir(), 'Variant Tool'), error })).status).toBe(204);
  expect(await heard).toEqual({ type: 'open-failed', folder: 'Variant Tool', reason: "The Kanban95 daemon did not say its port within 20s. Check the console for the daemon's error." });
  ws.close();
});

it('only the shell reports: a page sends Origin, a board started by hand has no shell, and a report without its fields is refused', async () => {
  const body = { path: join(tmpdir(), 'x'), error: 'e' };
  expect((await report(body, { origin: base })).status).toBe(403);
  expect((await report({ path: '', error: 'e' })).status).toBe(400);
  expect((await report({ path: 'x' })).status).toBe(400);
  srv.board.shell = undefined;
  expect((await report(body)).status).toBe(403);
});
