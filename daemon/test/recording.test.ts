import './home.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
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

const get = async () => {
  const r = await fetch(`http://127.0.0.1:${srv.port}/api/recording/tools`, { headers: { cookie: `k95=${srv.secret}` } });
  expect(r.status).toBe(200);
  return r.json();
};

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
