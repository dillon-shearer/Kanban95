import './home.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { boardHome } from '../src/settings.ts';
import { removeTemp } from './home.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  mkdirSync(boardHome(), { recursive: true });
  writeFileSync(join(boardHome(), 'settings.json'), JSON.stringify({ recording: { speed: 4, fps: 30, quality: 'small', keepRaw: true } }));
});
afterAll(async () => {
  await srv.close();
  removeTemp(repo);
});

const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const duration = (file: string) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true }).trim();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idle = async () => {
  for (let i = 0; i < 600; i++) {
    const body = await (await api('GET', '/recording')).json();
    if (body.state === 'idle') return body;
    await wait(100);
  }
  throw new Error('still busy after 60 s');
};

const folder = (name: string) => {
  const dir = join(repo, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'markers.json'), JSON.stringify({ speed: 4, fps: 30, marks: [{ t: 0, mode: 'regular' }, { t: 1, mode: 'fast' }] }));
  return { dir, raw: join(dir, 'raw.mkv') };
};

const unfinalised = (raw: string) => {
  const fd = openSync(raw, 'w');
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-f', 'matroska', 'pipe:1'], { stdio: ['ignore', fd, 'pipe'], windowsHide: true });
  } finally {
    closeSync(fd);
  }
};

it.runIf(hasFfmpeg)('render again repairs a raw.mkv with no readable length, keeps the original as raw-broken.mkv and writes 4x.mp4', async () => {
  const { dir, raw } = folder('unfinalised');
  unfinalised(raw);
  expect(duration(raw)).toBe('N/A');
  const original = readFileSync(raw);
  expect((await api('POST', '/recording/render', { raw })).status).toBe(200);
  const out = join(dir, '4x.mp4');
  expect(await idle()).toMatchObject({ output: out, error: null });
  expect(Math.abs(Number(duration(out)) - 2)).toBeLessThan(0.2);
  expect(Math.abs(Number(duration(raw)) - 5)).toBeLessThan(0.2);
  expect(readFileSync(join(dir, 'raw-broken.mkv')).equals(original)).toBe(true);
  expect(readdirSync(dir).sort()).toEqual(['4x.mp4', 'markers.json', 'raw-broken.mkv', 'raw.mkv', 'recording.log']);
}, 60_000);

it.runIf(hasFfmpeg)('render again on a raw.mkv that cannot be repaired leaves it untouched, leaves no temp file and names raw.mkv in the error', async () => {
  const { dir, raw } = folder('garbage');
  writeFileSync(raw, 'not a video');
  expect((await api('POST', '/recording/render', { raw })).status).toBe(200);
  const done = await idle();
  expect(done.output).toBeNull();
  expect(done.error).toContain('cannot read the length of raw.mkv');
  expect(done.error).toContain('repair: ffmpeg exited with code');
  expect(readFileSync(raw, 'utf8')).toBe('not a video');
  expect(readdirSync(dir).sort()).toEqual(['markers.json', 'raw.mkv', 'recording.log']);
}, 60_000);

it.runIf(hasFfmpeg)('when raw.mkv cannot be renamed the repair leaves it untouched, removes the temp file and says why', async () => {
  const { dir, raw } = folder('blocked');
  unfinalised(raw);
  const original = readFileSync(raw);
  mkdirSync(join(dir, 'raw-broken.mkv'));
  expect((await api('POST', '/recording/render', { raw })).status).toBe(200);
  const done = await idle();
  expect(done.output).toBeNull();
  expect(done.error).toContain('cannot read the length of raw.mkv');
  expect(done.error).toContain('repair: cannot rename raw.mkv');
  expect(readFileSync(raw).equals(original)).toBe(true);
  expect(readdirSync(dir).sort()).toEqual(['markers.json', 'raw-broken.mkv', 'raw.mkv', 'recording.log']);
}, 60_000);
