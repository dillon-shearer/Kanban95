import './home.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { boardHome } from '../src/settings.ts';
import { removeTemp } from './home.ts';

let repo: string;
let out: string;
let srv: Awaited<ReturnType<typeof start>>;
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const live = hasFfmpeg && process.platform === 'win32';
const OLD = '2026-10-29 09-00';
const NEW = '2026-10-30 09-00';

const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const duration = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true }).trim());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const markers = (folder: string) => JSON.parse(readFileSync(join(out, folder, 'markers.json'), 'utf8'));
const idle = async () => {
  for (let i = 0; i < 600; i++) {
    const body = await (await api('GET', '/recording')).json();
    if (body.state === 'idle') return body;
    await wait(100);
  }
  throw new Error('still busy after 60 s');
};
const refused = async (path: string, reason: RegExp, body?: unknown) => {
  const r = await api('POST', path, body);
  expect(r.status, path).toBe(409);
  expect((await r.json()).error, path).toMatch(reason);
};
const clip = (file: string, seconds: number) => {
  if (!hasFfmpeg) return writeFileSync(file, '');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=30`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], { windowsHide: true });
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  out = join(repo, 'videos');
  mkdirSync(boardHome(), { recursive: true });
  writeFileSync(join(boardHome(), 'settings.json'), JSON.stringify({ recording: { enabled: true, fps: 30, quality: 'small', speed: 4, output: out, keepRaw: true } }));
  mkdirSync(join(out, OLD), { recursive: true });
  writeFileSync(join(out, OLD, 'raw.mkv'), '');
  writeFileSync(join(out, OLD, 'markers.json'), JSON.stringify({ speed: 4, fps: 30, marks: [{ t: 0, mode: 'regular' }], paused: true, segments: [{ file: 'raw.mkv', seconds: 1 }] }));
  const old = new Date(Date.now() - 86_400_000);
  utimesSync(join(out, OLD, 'markers.json'), old, old);
  mkdirSync(join(out, NEW));
  clip(join(out, NEW, 'raw.mkv'), 2);
  clip(join(out, NEW, 'raw-2.mkv'), 3);
  const marks = [{ t: 0, mode: 'regular' }, { t: 1, mode: 'fast' }, { t: 2, mode: 'regular' }, { t: 3, mode: 'fast' }];
  writeFileSync(join(out, NEW, 'markers.json'), JSON.stringify({ speed: 4, fps: 30, marks, paused: true, segments: [{ file: 'raw.mkv', seconds: 2 }, { file: 'raw-2.mkv', seconds: 3 }] }));
  srv = await start({ repo });
});
afterAll(async () => {
  await srv.close();
  removeTemp(repo);
});

it('loads the newest paused folder in the output folder at daemon start, answering paused with the finished seconds', async () => {
  const r = await api('GET', '/recording');
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ state: 'paused', started: null, elapsed: 5, speed: 4, fastStretches: 2, error: null });
});

it('while paused, mode, start and pause answer 409 with the reason', async () => {
  await refused('/recording/mode', /paused: resume it first/, { mode: 'regular' });
  await refused('/recording/start', /^a paused recording exists: resume or stop it$/);
  await refused('/recording/pause', /already paused/);
  expect((await (await api('GET', '/recording')).json()).state).toBe('paused');
});

it.runIf(hasFfmpeg)('stop on a paused recording joins raw.mkv and raw-2.mkv into one raw.mkv, drops the parts and the paused keys, and renders it', async () => {
  const r = await api('POST', '/recording/stop');
  expect(r.status).toBe(200);
  expect((await r.json()).state).toBe('rendering');
  const done = await idle();
  const folder = join(out, NEW);
  expect(done).toMatchObject({ output: join(folder, '4x.mp4'), error: null, started: null });
  expect(readdirSync(folder).sort()).toEqual(['4x.mp4', 'markers.json', 'raw.mkv']);
  expect(Math.abs(duration(join(folder, 'raw.mkv')) - 5)).toBeLessThan(0.2);
  expect(Math.abs(duration(join(folder, '4x.mp4')) - (1 + 1 / 4 + 1 + 2 / 4))).toBeLessThan(0.2);
  const m = markers(NEW);
  expect(m).not.toHaveProperty('paused');
  expect(m).not.toHaveProperty('segments');
  expect(m.marks).toHaveLength(4);
  expect(markers(OLD).paused).toBe(true);
  await refused('/recording/pause', /not recording/);
  await refused('/recording/resume', /nothing is paused/);
}, 60_000);

it.runIf(live)('pause closes raw.mkv into a segment, resume records raw-2.mkv on one clock, and stop joins them', async () => {
  const before = new Set(readdirSync(out));
  expect((await api('POST', '/recording/start')).status).toBe(200);
  const [folder] = readdirSync(out).filter((f) => !before.has(f));
  await refused('/recording/resume', /already recording/);
  await wait(1500);
  expect((await (await api('POST', '/recording/mode', { mode: 'fast' })).json()).mode).toBe('fast');
  await wait(500);
  const p = await api('POST', '/recording/pause');
  expect(p.status).toBe(200);
  const paused = markers(folder);
  expect(paused.paused).toBe(true);
  expect(paused.segments).toHaveLength(1);
  expect(paused.segments[0].file).toBe('raw.mkv');
  const seconds = paused.segments[0].seconds;
  expect(seconds).toBeGreaterThan(1);
  expect(await p.json()).toMatchObject({ state: 'paused', started: null, elapsed: seconds });
  expect(await (await api('GET', '/recording')).json()).toMatchObject({ state: 'paused', started: null, elapsed: seconds });
  await refused('/recording/mode', /paused/, { mode: 'regular' });

  const r = await api('POST', '/recording/resume');
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ state: 'recording', mode: 'regular', elapsed: seconds });
  expect(markers(folder).marks.at(-1)).toEqual({ t: seconds, mode: 'regular' });
  await wait(1500);
  expect(existsSync(join(out, folder, 'raw-2.mkv'))).toBe(true);
  await api('POST', '/recording/mode', { mode: 'fast' });
  const t = markers(folder).marks.at(-1).t;
  expect(t).toBeGreaterThan(seconds);
  expect(t).toBeLessThan(seconds + 5);

  expect((await api('POST', '/recording/stop')).status).toBe(200);
  const done = await idle();
  expect(done.error).toBeNull();
  expect(readdirSync(join(out, folder)).sort()).toEqual(['4x.mp4', 'markers.json', 'raw.mkv']);
  const m = markers(folder);
  expect(m).not.toHaveProperty('paused');
  expect(m).not.toHaveProperty('segments');
}, 90_000);

it.runIf(live)('closing the board while recording leaves the folder paused, and the next start loads it', async () => {
  const before = new Set(readdirSync(out));
  expect((await api('POST', '/recording/start')).status).toBe(200);
  const [folder] = readdirSync(out).filter((f) => !before.has(f));
  await wait(1500);
  await srv.close();
  const m = markers(folder);
  expect(m.paused).toBe(true);
  expect(m.segments.map((s: { file: string }) => s.file)).toEqual(['raw.mkv']);
  srv = await start({ repo });
  expect(await (await api('GET', '/recording')).json()).toMatchObject({ state: 'paused', elapsed: m.segments[0].seconds, started: null });
  rmSync(join(out, folder), { recursive: true, force: true });
}, 60_000);
