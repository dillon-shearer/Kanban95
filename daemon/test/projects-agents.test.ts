import './home.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { entryPath } from '../src/boards.ts';
import { killTree, sessions } from '../src/launcher.ts';
import { start } from '../src/server.ts';
import { writeProjects } from '../src/settings.ts';

const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const PATH0 = process.env.PATH;
let repo: string;
let other: string;
let srv: Awaited<ReturnType<typeof start>>;

const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const entry = () => JSON.parse(readFileSync(entryPath(process.pid), 'utf8'));
const agents = async () => (await (await api('GET', '/projects')).json()).agents;

beforeAll(async () => {
  writeFileSync(join(bin, 'fake.mjs'), "console.log('FAKE UP');\nprocess.stdin.resume();\n");
  writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
  process.env.PATH = bin + delimiter + PATH0;
  mkdirSync(join(process.env.USERPROFILE!, '.kanban95'), { recursive: true });
  writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({ cli: 'claude', claude: { plan: { model: 'plan-m', effort: 'low' } } }));
  [repo, other] = [0, 1].map(() => {
    const r = mkdtempSync(join(tmpdir(), 'k95-agents-'));
    execFileSync('git', ['init', '-q'], { cwd: r });
    return r;
  });
  srv = await start({ repo });
  writeProjects([{ path: repo, colour: '#008080' }, { path: other, colour: 120 }], repo);
});
afterAll(async () => {
  await srv?.close();
  process.env.PATH = PATH0;
  for (const d of [repo, other]) rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  rmSync(bin, { recursive: true, force: true });
});

it('the running entry and GET /api/projects count a session up on launch and down when it ends', async () => {
  expect(entry().agents).toBe(0);
  expect(await agents()).toEqual({ [repo]: 0 });

  const r = await api('POST', '/operator', { mission: 'count me' });
  expect(r.status).toBe(201);
  const s = sessions.get((await r.json()).id)!;
  expect(entry().agents).toBe(1);
  expect(await agents()).toEqual({ [repo]: 1 });

  const t0 = Date.now();
  while (!s.scrollback().includes('FAKE UP')) {
    if (Date.now() - t0 > 20_000) throw new Error('fake never came up');
    await new Promise((ok) => setTimeout(ok, 25));
  }
  killTree(s.pty);
  await s.done;
  expect(entry().agents).toBe(0);
  expect(await agents()).toEqual({ [repo]: 0 });
});
