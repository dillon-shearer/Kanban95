import './home.ts';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { entryPath } from '../src/boards.ts';
import { start } from '../src/server.ts';
import { writeProjects } from '../src/settings.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
const repo = () => {
  const r = mkdtempSync(join(tmpdir(), 'k95-shell-'));
  execFileSync('git', ['init', '-q'], { cwd: r });
  dirs.push(r);
  return r;
};
const sleepers: ChildProcess[] = [];
const livePid = () => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  sleepers.push(c);
  return c.pid!;
};
const fake = (pid: number, repo: string, shell: number | null) =>
  writeFileSync(entryPath(pid), JSON.stringify({ pid, repo, port: 1, started: new Date().toISOString(), shell }));
afterAll(() => {
  for (const c of sleepers) c.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

describe('in-process board under shell 123', () => {
  let own: string, hosted: string, elsewhere: string, idle: string, unlisted: string;
  let srv: Awaited<ReturnType<typeof start>>;
  const lines: string[] = [];
  beforeAll(async () => {
    [own, hosted, elsewhere, idle, unlisted] = [repo(), repo(), repo(), repo(), repo()];
    srv = await start({ repo: own, shellId: 123 });
    srv.board.shell = true;
    writeProjects([own, hosted, elsewhere, idle].map((path) => ({ path, colour: '#008080' })), own);
    fake(livePid(), hosted, 123);
    fake(livePid(), elsewhere, 999);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await srv?.close();
  });
  const call = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${srv.port}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const tools = () => srv.db.prepare('SELECT tool, outcome FROM audit ORDER BY id').all().map((r) => `${r.tool}:${r.outcome}`);

  it('its own registry entry carries the shell id', () => {
    expect(JSON.parse(readFileSync(entryPath(process.pid), 'utf8')).shell).toBe(123);
  });

  it('GET /api/projects marks hosted only the projects whose entry has this board\'s shell', async () => {
    const body = await (await call('/projects')).json();
    expect(body.hosted).toEqual({ [own]: true, [hosted]: true, [elsewhere]: false, [idle]: false });
    expect(body.running).toEqual({ [own]: true, [hosted]: true, [elsewhere]: true, [idle]: false });
  });

  it('switch, popout, dock and close write one line for a hosted project, 400 unlisted, 409 not hosted', async () => {
    for (const verb of ['switch', 'popout', 'dock', 'close']) {
      lines.length = 0;
      const r = await call(`/projects/${verb}`, { path: `${hosted}/` });
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ name: hosted.split(/[\\/]/).pop() });
      expect(lines).toEqual([`KANBAN95 ${verb}=${hosted}\n`]);
      lines.length = 0;
      expect((await call(`/projects/${verb}`, { path: unlisted })).status).toBe(400);
      expect((await call(`/projects/${verb}`, {})).status).toBe(400);
      expect((await call(`/projects/${verb}`, { path: elsewhere })).status).toBe(409);
      expect((await call(`/projects/${verb}`, { path: idle })).status).toBe(409);
      expect(lines).toEqual([]);
      expect(tools().filter((t) => t.startsWith(`projects.${verb}:`))).toEqual([`projects.${verb}:ok`, ...Array(4).fill(`projects.${verb}:error`)]);
    }
  });

  it('close of this board\'s own path is allowed', async () => {
    lines.length = 0;
    expect((await call('/projects/close', { path: own })).status).toBe(202);
    expect(lines).toEqual([`KANBAN95 close=${own}\n`]);
  });

  it('open here asks for open on an idle project, switch on a hosted one, and refuses one in another shell', async () => {
    lines.length = 0;
    expect((await call('/projects/open', { path: idle, where: 'here' })).status).toBe(202);
    expect((await call('/projects/open', { path: hosted, where: 'here' })).status).toBe(202);
    expect(lines).toEqual([`KANBAN95 open=${idle}\n`, `KANBAN95 switch=${hosted}\n`]);
    lines.length = 0;
    expect((await call('/projects/open', { path: elsewhere, where: 'here' })).status).toBe(409);
    expect((await call('/projects/open', { path: idle, where: 'nowhere' })).status).toBe(400);
    expect(lines).toEqual([]);
  });

  it('every route refuses with 409 and writes nothing when the board has no shell', async () => {
    srv.board.shell = false;
    lines.length = 0;
    try {
      for (const verb of ['switch', 'popout', 'dock', 'close']) expect((await call(`/projects/${verb}`, { path: hosted })).status).toBe(409);
      expect((await call('/projects/open', { path: idle, where: 'here' })).status).toBe(409);
      expect(lines).toEqual([]);
    } finally {
      srv.board.shell = true;
    }
  });
});

describe('daemon process', () => {
  const secret = 'c'.repeat(64);
  const boot = async (repo: string, env: Record<string, string>) => {
    const { KANBAN95_SHELL: _a, KANBAN95_SHELL_ID: _b, ...base } = process.env;
    const child = spawn(process.execPath, [join(ROOT, 'daemon/dist/server.js'), repo], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...base, ...env, KANBAN95_SECRET: secret } });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    while (!/port=(\d+)\n/.test(out)) await once(child.stdout!, 'data');
    const port = Number(/port=(\d+)/.exec(out)![1]);
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `k95=${secret}` }, body: JSON.stringify(body) });
    const stop = async () => {
      const exited = once(child, 'exit');
      child.stdin!.end();
      await exited;
    };
    return { child, post, stop, out: () => out };
  };

  it('under shell 123 writes shell:123 to its entry, asks for an update check, and exactly one open line for open here', async () => {
    const [own, other] = [repo(), repo()];
    writeProjects([{ path: own, colour: '#008080' }, { path: other, colour: '#008080' }], own);
    const d = await boot(own, { KANBAN95_SHELL: '1', KANBAN95_SHELL_ID: '123' });
    try {
      expect(JSON.parse(readFileSync(entryPath(d.child.pid!), 'utf8'))).toMatchObject({ repo: own, shell: 123 });
      const r = await d.post('/projects/open', { path: other, where: 'here' });
      expect(r.status).toBe(202);
      await new Promise((ok) => setTimeout(ok, 200));
      expect(d.out().split('\n').slice(1)).toEqual([`KANBAN95 repo=${own}`, `KANBAN95 check=${own}`, `KANBAN95 open=${other}`, '']);
    } finally {
      await d.stop();
    }
  }, 30_000);

  it('started by hand writes shell:null, and open here answers 409 and writes nothing', async () => {
    const [own, other] = [repo(), repo()];
    writeProjects([{ path: own, colour: '#008080' }, { path: other, colour: '#008080' }], own);
    const d = await boot(own, {});
    try {
      expect(JSON.parse(readFileSync(entryPath(d.child.pid!), 'utf8')).shell).toBeNull();
      expect((await d.post('/projects/open', { path: other, where: 'here' })).status).toBe(409);
      await new Promise((ok) => setTimeout(ok, 200));
      expect(d.out().split('\n').slice(1)).toEqual([`KANBAN95 repo=${own}`, '']);
    } finally {
      await d.stop();
    }
  }, 30_000);
});

describe('stdout rule', () => {
  it('after the port line only tellShell writes to stdout', () => {
    const src = join(ROOT, 'daemon/src');
    const hits = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => readFileSync(join(src, f), 'utf8').split('\n').map((line) => ({ f: f.replace(/\\/g, '/'), line: line.trim() })))
      .filter(({ line }) => /process\.stdout\b|console\.(log|info|debug|dir|table|trace)\b/.test(line))
      .map(({ f, line }) => `${f}: ${line}`);
    expect(hits).toEqual([
      'boards.ts: process.stdout.write(`KANBAN95 ${verb}=${path && normal(path)}${rest && \' \' + rest}\\n`);',
      'server.ts: const handshake = (port: number) => console.log(`KANBAN95 port=${port}`);',
      'server.ts: console.log((e as Error).message);',
    ]);
  });
});
