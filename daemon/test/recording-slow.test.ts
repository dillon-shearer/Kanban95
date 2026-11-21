import './home.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { graph, type Mark } from '../src/recording.ts';
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
const idle = async () => {
  for (let i = 0; i < 600; i++) {
    const body = await (await api('GET', '/recording')).json();
    if (body.state === 'idle') return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('still busy after 60 s');
};
const clip = (folder: string) => {
  const dir = join(repo, folder);
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, 'raw.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', raw], { windowsHide: true });
  writeFileSync(join(dir, 'markers.json'), JSON.stringify({ speed: 10, fps: 30, marks: [{ t: 0, mode: 'regular' }, { t: 1, mode: 'fast' }] }));
  return { dir, raw };
};

it('settings accept recording.slow 1, 1.5 and 10, default it to 1, and refuse 0.5, 11 and a slow at or above speed', () => {
  write({ recording: {} });
  expect(readConfig('settings', repo).recording.slow).toBe(1);
  for (const slow of [1, 1.5, 10]) {
    write({ recording: { slow, speed: 20 } });
    expect(readConfig('settings', repo).recording.slow).toBe(slow);
  }
  for (const recording of [{ slow: 0.5 }, { slow: 11, speed: 20 }, { slow: 10 }, { slow: 5, speed: 4 }]) {
    write({ recording });
    expect(() => readConfig('settings', repo), JSON.stringify(recording)).toThrow(/slow/);
  }
  write({ recording: { slow: 10 } });
  expect(() => readConfig('settings', repo)).toThrow(/lower than recording.speed/);
});

describe('graph with slow', () => {
  const marks: Mark[] = [{ t: 0, mode: 'regular' }, { t: 3, mode: 'fast' }, { t: 8.25, mode: 'regular' }];

  it('slow 1 gives the graph from before slow existed', () => {
    const before = '[0:v]split=3[s0][s1][s2];[s0]trim=start=0:end=3,setpts=(PTS-STARTPTS)/1[v0];[s1]trim=start=3:end=8.25,setpts=(PTS-STARTPTS)/10,fps=60[v1];'
      + '[s2]trim=start=8.25:end=20,setpts=(PTS-STARTPTS)/1[v2];[v0][v1][v2]concat=n=3:v=1:a=0[out]';
    expect(graph(marks, 20, 10, 60, 1)).toBe(before);
    expect(graph(marks, 20, 10, 60)).toBe(before);
  });

  it('slow 2 divides regular stretches by 2 and fast ones by the fast speed, both resampled', () => {
    expect(graph(marks, 20, 10, 60, 2)).toBe('[0:v]split=3[s0][s1][s2];[s0]trim=start=0:end=3,setpts=(PTS-STARTPTS)/2,fps=60[v0];'
      + '[s1]trim=start=3:end=8.25,setpts=(PTS-STARTPTS)/10,fps=60[v1];[s2]trim=start=8.25:end=20,setpts=(PTS-STARTPTS)/2,fps=60[v2];[v0][v1][v2]concat=n=3:v=1:a=0[out]');
  });
});

it('render again answers 400 for slow 0.5, 11 and slow at or above speed', async () => {
  for (const body of [{ slow: 0.5 }, { slow: 11 }, { slow: 10, speed: 10 }, { slow: 5, speed: 4 }, { slow: '2' }]) {
    expect((await api('POST', '/recording/render', { raw: join(repo, 'raw.mkv'), ...body })).status, JSON.stringify(body)).toBe(400);
  }
});

it.runIf(hasFfmpeg)('a markers.json without slow renders at slow 1 into 10x.mp4, and slow 2 from the body into 2x-10x.mp4', async () => {
  const { dir, raw } = clip('2026-11-20 10-00');
  write({ recording: { speed: 10, fps: 30, quality: 'small', keepRaw: true } });
  let r = await api('POST', '/recording/render', { raw });
  expect(r.status).toBe(200);
  expect((await r.json()).slow).toBe(1);
  expect(await idle()).toMatchObject({ output: join(dir, '10x.mp4'), error: null });
  expect(Math.abs(duration(join(dir, '10x.mp4')) - 1.4)).toBeLessThan(0.2);
  expect(readFileSync(join(dir, 'recording.log'), 'utf8')).toMatch(/^.* render: speed 10x, total 5(.d+)? s$/m);

  r = await api('POST', '/recording/render', { raw, slow: 2 });
  expect(r.status).toBe(200);
  expect((await r.json())).toMatchObject({ speed: 10, slow: 2 });
  const out = join(dir, '2x-10x.mp4');
  expect(await idle()).toMatchObject({ output: out, error: null });
  expect(Math.abs(duration(out) - 0.9)).toBeLessThan(0.2);
  expect(readFileSync(join(dir, 'recording.log'), 'utf8')).toContain('render: speed 10x, slow 2x, total');
  expect(existsSync(join(dir, '10x.mp4'))).toBe(true);
  const titles = (await (await api('GET', '/deliverables')).json()).map((d: { title: string }) => d.title);
  expect(titles).toEqual(expect.arrayContaining(['Recording 2026-11-20 10-00 10x', 'Recording 2026-11-20 10-00 2x-10x']));
}, 60_000);

it.runIf(hasFfmpeg)('render again without slow uses recording.slow, printed as typed in the file name', async () => {
  const { dir, raw } = clip('2026-11-20 11-00');
  write({ recording: { speed: 10, slow: 1.5, fps: 30, quality: 'small', keepRaw: true } });
  const r = await api('POST', '/recording/render', { raw });
  expect(r.status).toBe(200);
  expect((await r.json()).slow).toBe(1.5);
  expect(await idle()).toMatchObject({ output: join(dir, '1.5x-10x.mp4'), error: null });
}, 60_000);
