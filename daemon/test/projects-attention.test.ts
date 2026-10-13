import './home.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { entryPath } from '../src/boards.ts';
import { start } from '../src/server.ts';
import { writeProjects } from '../src/settings.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;

const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const entry = () => JSON.parse(readFileSync(entryPath(process.pid), 'utf8'));
const attention = async () => (await (await api('GET', '/projects')).json()).attention;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-attn-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  srv = await start({ repo });
  writeProjects([{ path: repo, colour: '#008080' }], repo);
});
afterAll(async () => {
  await srv?.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
});

it('the running entry and GET /api/projects count flagged tickets up and back down', async () => {
  expect(entry().attention).toBe(0);
  expect(await attention()).toEqual({ [repo]: 0 });

  const a = (await (await api('POST', '/tickets', { title: 'a' })).json()).id;
  const b = (await (await api('POST', '/tickets', { title: 'b' })).json()).id;
  expect((await api('PATCH', `/tickets/${a}`, { needs_human: true })).status).toBe(200);
  expect(entry().attention).toBe(1);
  expect(await attention()).toEqual({ [repo]: 1 });

  await api('PATCH', `/tickets/${b}`, { needs_human: true });
  expect(entry().attention).toBe(2);

  await api('PATCH', `/tickets/${a}`, { needs_human: false });
  await api('DELETE', `/tickets/${b}`);
  expect(entry().attention).toBe(0);
  expect(await attention()).toEqual({ [repo]: 0 });
});
