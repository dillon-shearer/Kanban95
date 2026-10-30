import './home.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { graph } from '../src/recording.ts';
import { start } from '../src/server.ts';
import { boardHome, readConfig } from '../src/settings.ts';
import { removeTemp } from './home.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const settings = () => join(boardHome(), 'settings.json');
const write = (v: unknown) => {
  mkdirSync(boardHome(), { recursive: true });
  writeFileSync(settings(), JSON.stringify(v));
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
});
afterEach(() => rmSync(settings(), { force: true }));
afterAll(async () => {
  await srv.close();
  removeTemp(repo);
});

const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const duration = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true }).trim());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idle = async () => {
  for (let i = 0; i < 600; i++) {
    const body = await (await api('GET', '/recording')).json();
    if (body.state === 'idle') return body;
    await wait(100);
  }
  throw new Error('still busy after 60 s');
};

const get = async () => {
  const r = await fetch(`http://127.0.0.1:${srv.port}/api/recording/tools`, { headers: { cookie: `k95=${srv.secret}` } });
  expect(r.status).toBe(200);
  return r.json();
};

it('GET /api/recording on a fresh board answers idle', async () => {
  const r = await api('GET', '/recording');
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ state: 'idle', mode: 'regular', started: null, elapsed: 0, speed: 10, progress: null, output: null, error: null });
});

it('a settings.json without recording yields the recording defaults', () => {
  write({ zoom: 1 });
  expect(readConfig('settings', repo).recording).toEqual({ enabled: false, ffmpeg: '', monitor: 0, fps: 60, quality: 'high', speed: 10, output: '', keepRaw: true });
});

it('refuses a speed under 2, an unknown quality, an fps other than 30 or 60 and a relative output', () => {
  for (const recording of [{ speed: 1 }, { quality: 'ultra' }, { fps: 45 }, { output: 'videos' }, { monitor: -1 }]) {
    write({ recording });
    expect(() => readConfig('settings', repo), JSON.stringify(recording)).toThrow(/recording/);
  }
  write({ recording: { speed: 60, fps: 30, quality: 'small' } });
  expect(readConfig('settings', repo).recording).toMatchObject({ speed: 60, fps: 30, quality: 'small' });
});

it('answers ffmpeg null when the configured ffmpeg does not exist', async () => {
  write({ recording: { ffmpeg: join(repo, 'nope', 'ffmpeg.exe') } });
  const body = await get();
  expect(body.ffmpeg).toBeNull();
  expect(Array.isArray(body.monitors)).toBe(true);
}, 40_000);

it('answers ffmpeg null when the configured file is not an executable', async () => {
  const fake = join(repo, 'ffmpeg.txt');
  writeFileSync(fake, 'not a program');
  write({ recording: { ffmpeg: fake } });
  expect((await get()).ffmpeg).toBeNull();
}, 40_000);

it.runIf(process.platform === 'win32')('lists the Windows monitors by device name, indexed in order', async () => {
  const { monitors } = await get();
  expect(monitors.length).toBeGreaterThan(0);
  monitors.forEach((m: { index: number; name: string; width: number }, i: number) => {
    expect(m.index).toBe(i);
    expect(m.name.startsWith('\\\\.\\DISPLAY')).toBe(true);
    expect(m.width).toBeGreaterThan(0);
  });
  expect(monitors.filter((m: { primary: boolean }) => m.primary)).toHaveLength(1);
}, 40_000);

describe('graph', () => {
  const regular = (a: string, b: string, i: number) => `[s${i}]trim=start=${a}:end=${b},setpts=(PTS-STARTPTS)/1[v${i}]`;
  const split = (n: number) => `[0:v]split=${n}${Array.from({ length: n }, (_, i) => `[s${i}]`).join('')}`;
  const fast = (a: string, b: string, i: number) => `[s${i}]trim=start=${a}:end=${b},setpts=(PTS-STARTPTS)/10,fps=60[v${i}]`;

  it('no marks is one regular stretch over the whole recording', () => {
    expect(graph([], 12.5, 10, 60)).toBe(`[0:v]split=1[s0];${regular('0', '12.5', 0)};[v0]concat=n=1:v=1:a=0[out]`);
    expect(graph([{ t: 0, mode: 'regular' }], 12.5, 10, 60)).toBe(graph([], 12.5, 10, 60));
  });

  it('a fast stretch in the middle is sped up and resampled to the frame rate', () => {
    expect(graph([{ t: 0, mode: 'regular' }, { t: 3, mode: 'fast' }, { t: 8.25, mode: 'regular' }], 20, 10, 60))
      .toBe([split(3), regular('0', '3', 0), fast('3', '8.25', 1), regular('8.25', '20', 2), '[v0][v1][v2]concat=n=3:v=1:a=0[out]'].join(';'));
  });

  it('a fast stretch at the end runs to the end of the recording, and a mark past the end is dropped', () => {
    const trailing = graph([{ t: 0, mode: 'regular' }, { t: 3, mode: 'fast' }], 9, 10, 60);
    expect(trailing).toBe([split(2), regular('0', '3', 0), fast('3', '9', 1), '[v0][v1]concat=n=2:v=1:a=0[out]'].join(';'));
    expect(graph([{ t: 0, mode: 'regular' }, { t: 3, mode: 'fast' }, { t: 9.5, mode: 'regular' }], 9, 10, 60)).toBe(trailing);
  });

  it('two marks of the same mode in a row count as one', () => {
    expect(graph([{ t: 0, mode: 'regular' }, { t: 2, mode: 'fast' }, { t: 4, mode: 'fast' }, { t: 6, mode: 'regular' }, { t: 7, mode: 'regular' }], 10, 10, 60))
      .toBe([split(3), regular('0', '2', 0), fast('2', '6', 1), regular('6', '10', 2), '[v0][v1][v2]concat=n=3:v=1:a=0[out]'].join(';'));
  });

  it('a fast mark at zero leaves no empty regular stretch', () => {
    expect(graph([{ t: 0, mode: 'regular' }, { t: 0, mode: 'fast' }], 5, 10, 60)).toBe(`[0:v]split=1[s0];${fast('0', '5', 0)};[v0]concat=n=1:v=1:a=0[out]`);
  });
});

it('start answers 409 with the reason while recording is off', async () => {
  write({ recording: { enabled: false } });
  const r = await api('POST', '/recording/start');
  expect(r.status).toBe(409);
  expect((await r.json()).error).toMatch(/recording is off/);
  expect((await (await api('GET', '/recording')).json()).state).toBe('idle');
});

it('mode, stop and render are refused when there is nothing to act on', async () => {
  expect((await api('POST', '/recording/mode', { mode: 'fast' })).status).toBe(409);
  expect((await api('POST', '/recording/mode', { mode: 'slow' })).status).toBe(400);
  expect((await api('POST', '/recording/stop')).status).toBe(409);
  expect((await api('POST', '/recording/render', { raw: join(repo, 'nope raw.mkv') })).status).toBe(409);
});

it.runIf(hasFfmpeg)('renders a 5 s raw with 1-5 s at 4x into a 2 s mp4 and lists it in the Inbox', async () => {
  const dir = join(repo, 'render');
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, 'clip raw.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', raw], { windowsHide: true });
  writeFileSync(join(dir, 'clip markers.json'), JSON.stringify({ speed: 4, fps: 30, marks: [{ t: 0, mode: 'regular' }, { t: 1, mode: 'fast' }] }));
  write({ recording: { speed: 4, fps: 30, quality: 'small', keepRaw: true } });
  const r = await api('POST', '/recording/render', { raw });
  expect(r.status).toBe(200);
  expect((await r.json()).state).toBe('rendering');
  expect((await api('POST', '/recording/render', { raw })).status).toBe(409);
  const done = await idle();
  const out = join(dir, 'clip.mp4');
  expect(done).toMatchObject({ output: out, error: null });
  expect(Math.abs(duration(out) - 2)).toBeLessThan(0.2);
  expect(existsSync(raw)).toBe(true);
  const inbox = await (await api('GET', '/deliverables')).json();
  expect(inbox).toContainEqual(expect.objectContaining({ folder: out, ticket_id: null }));
}, 60_000);

it.runIf(hasFfmpeg && process.platform === 'win32')('records the desktop, sends a recording frame on start, mode change and stop, and drops the raw when keepRaw is off', async () => {
  const dir = join(repo, 'videos');
  write({ recording: { enabled: true, fps: 30, quality: 'small', output: dir, keepRaw: false } });
  const frames: { state: string; mode: string; output: string | null }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/events`, { origin: `http://127.0.0.1:${srv.port}`, headers: { cookie: `k95=${srv.secret}` } });
  ws.on('message', (m) => {
    const e = JSON.parse(String(m));
    if (e.recording) frames.push(e.recording);
  });
  await new Promise((r) => ws.once('open', r));
  try {
    const r = await api('POST', '/recording/start');
    const body = await r.json();
    expect(r.status, body.error).toBe(200);
    expect(body.state).toBe('recording');
    expect((await api('POST', '/recording/start')).status).toBe(409);
    await wait(1500);
    expect((await (await api('POST', '/recording/mode', { mode: 'fast' })).json()).mode).toBe('fast');
    await api('POST', '/recording/mode', { mode: 'fast' });
    await wait(1500);
    expect((await (await api('POST', '/recording/stop')).json()).state).toBe('rendering');
    const done = await idle();
    expect(done.error).toBeNull();
    await wait(100);
    expect(frames.slice(0, 3).map((f) => [f.state, f.mode])).toEqual([['recording', 'regular'], ['recording', 'fast'], ['rendering', 'fast']]);
    expect(frames.at(-1)).toMatchObject({ state: 'idle', output: done.output });
    expect(existsSync(done.output)).toBe(true);
    const stem = done.output.slice(0, -'.mp4'.length);
    expect(existsSync(`${stem} raw.mkv`)).toBe(false);
    expect(existsSync(`${stem} markers.json`)).toBe(false);
  } finally {
    ws.close();
  }
}, 90_000);
