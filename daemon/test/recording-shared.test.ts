import './home.ts';
import { execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { entryPath } from '../src/boards.ts';
import { start } from '../src/server.ts';
import { boardHome } from '../src/settings.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const SECRET = 'c'.repeat(64);
const live = process.platform === 'win32' && spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const temps: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
let a: Awaited<ReturnType<typeof start>> | null = null;
let b: ChildProcess;
let bPort: number;
let repoA: string;
let started: string;

const call = (port: number, secret: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: `k95=${secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const onA = (method: string, path: string, body?: unknown) => call(a!.port, a!.secret)(method, path, body);
const onB = (method: string, path: string, body?: unknown) => call(bPort, SECRET)(method, path, body);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(on: typeof onA, state: string, ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    const v = (await on('GET', '/recording')).body;
    if (v.state === state || Date.now() > end) return v;
    await wait(100);
  }
}

beforeAll(async () => {
  execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  repoA = temp('k95-ra-');
  const repoB = temp('k95-rb-');
  mkdirSync(boardHome(), { recursive: true });
  writeFileSync(join(boardHome(), 'settings.json'), JSON.stringify({ recording: { enabled: true, fps: 30, quality: 'small', speed: 4, output: join(temp('k95-rv-'), 'videos'), keepRaw: true } }));
  a = await start({ repo: repoA });
  const { KANBAN95_SHELL: _, ...env } = process.env;
  b = spawn(process.execPath, [join(ROOT, 'daemon/dist/server.js'), repoB], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...env, KANBAN95_SECRET: SECRET } });
  const [chunk] = await once(b.stdout!, 'data');
  bPort = Number(/port=(\d+)/.exec(String(chunk))![1]);
}, 60_000);
afterAll(async () => {
  if (b && b.exitCode === null) {
    const exited = once(b, 'exit');
    b.stdin!.end();
    await exited;
  }
  await a?.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

it('a recording.json naming a pid that is not running is ignored: both boards report idle and start is not refused for it', async () => {
  const gone = spawn(process.execPath, ['-e', '']);
  await once(gone, 'exit');
  writeFileSync(join(boardHome(), 'recording.json'), JSON.stringify({ state: 'recording', mode: 'fast', started: new Date().toISOString(), elapsed: 0, speed: 4, progress: null, output: null, error: null, fastStretches: 1, pid: gone.pid, port: 1, repo: 'elsewhere' }));
  expect((await onB('GET', '/recording')).body.state).toBe('idle');
  expect((await onA('GET', '/recording')).body.state).toBe('idle');
  const r = await onA('POST', '/recording/start');
  if (!live) return expect(r.body.error).not.toMatch(/elsewhere/);
  expect(r.status, r.body.error).toBe(200);
  started = r.body.started;
});

it.runIf(live)('the second board shows the first board\'s recording within 2 s, with the same start time and mode', async () => {
  const v = await until(onB, 'recording', 2000);
  expect(v).toMatchObject({ state: 'recording', started, mode: 'regular' });
});

it.runIf(live)('start on the second board while the first records answers 409 naming the first board\'s folder', async () => {
  const r = await onB('POST', '/recording/start');
  expect(r.status).toBe(409);
  expect(r.body.error).toBe(`${basename(repoA)} is recording`);
});

it.runIf(live)('mode, pause and resume on the second board act on the first board\'s recording', async () => {
  expect((await onB('POST', '/recording/mode', { mode: 'fast' })).body.mode).toBe('fast');
  expect((await onA('GET', '/recording')).body.mode).toBe('fast');
  await wait(1500);
  const p = await onB('POST', '/recording/pause');
  expect(p.status, p.body.error).toBe(200);
  expect(p.body.state).toBe('paused');
  expect((await onA('GET', '/recording')).body.state).toBe('paused');
  expect((await onB('GET', '/recording')).body.state).toBe('paused');
  const r = await onB('POST', '/recording/resume');
  expect(r.status, r.body.error).toBe(200);
  expect((await onA('GET', '/recording')).body.state).toBe('recording');
}, 30_000);

it('the owner route refuses a missing or wrong key with 401 and leaves the recording alone', async () => {
  const before = (await onA('GET', '/recording')).body.state;
  const relay = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${a!.port}/api/recording/relay/pause`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  expect((await relay({})).status).toBe(401);
  expect((await relay({ 'x-k95-key': 'f'.repeat(64) })).status).toBe(401);
  expect(JSON.parse(readFileSync(entryPath(process.pid), 'utf8')).key).toMatch(/^[0-9a-f]{64}$/);
  expect((await onA('GET', '/recording')).body.state).toBe(before);
});

it.runIf(live)('closing the first board while recording leaves it paused on the second, whose resume takes it over', async () => {
  await wait(1000);
  await a!.close();
  a = null;
  expect((await until(onB, 'paused', 3000)).state).toBe('paused');
  const r = await onB('POST', '/recording/resume');
  expect(r.status, r.body.error).toBe(200);
  expect(r.body.state).toBe('recording');
  const owner = JSON.parse(readFileSync(join(boardHome(), 'recording.json'), 'utf8'));
  expect(owner).toMatchObject({ state: 'recording', pid: b.pid, port: bPort });
}, 30_000);
