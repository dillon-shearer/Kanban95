import './home.ts';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { start } from '../src/server.ts';
import { stop } from '../src/recording.ts';
import { boardHome } from '../src/settings.ts';
import { removeTemp } from './home.ts';

type Fake = { file: string; quits: boolean; kills: number; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; finish: (code: number | null) => void };
const fakes = vi.hoisted(() => ({ list: [] as Fake[], quits: true }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const capture = (file: string) => {
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    let done = false;
    const f: Fake = {
      file,
      quits: fakes.quits,
      kills: 0,
      stdout: proc.stdout,
      stderr: proc.stderr,
      finish: (code) => {
        if (done) return;
        done = true;
        setImmediate(() => {
          proc.stdout.end();
          proc.stderr.end();
          proc.emit('exit', code);
        });
      },
    };
    proc.stdin.on('data', (d) => {
      if (f.quits && String(d).includes('q')) f.finish(0);
    });
    Object.assign(proc, { kill: () => (f.kills++, f.finish(null), true) });
    fakes.list.push(f);
    return proc;
  };
  return {
    ...real,
    spawn: (exe: string, args: string[], opts: object) => (args.includes('-stats_period') ? capture(args.at(-1)!) : real.spawn(exe, args, opts)),
  };
});

let repo: string;
let out: string;
let srv: Awaited<ReturnType<typeof start>>;
const live = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0 && process.platform === 'win32';

const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = async () => (await api('GET', '/recording')).json();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (state: string) => {
  for (let i = 0; i < 600; i++) {
    const body = await get();
    if (body.state === state) return body;
    await wait(100);
  }
  throw new Error(`not ${state} after 60 s`);
};
const markers = (folder: string) => JSON.parse(readFileSync(join(folder, 'markers.json'), 'utf8'));
const duration = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true }).trim());
const clip = (file: string, seconds: number, finalised = true) => {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=30`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  if (finalised) return void execFileSync('ffmpeg', [...args, file], { windowsHide: true });
  const fd = openSync(file, 'w');
  try {
    execFileSync('ffmpeg', [...args, '-f', 'matroska', 'pipe:1'], { stdio: ['ignore', fd, 'pipe'], windowsHide: true });
  } finally {
    closeSync(fd);
  }
};
const begin = async () => {
  const before = new Set(existsSync(out) ? readdirSync(out) : []);
  expect((await api('POST', '/recording/start')).status).toBe(200);
  const [name] = readdirSync(out).filter((f) => !before.has(f));
  return { folder: join(out, name), f: fakes.list.at(-1)! };
};
const died = async () => {
  const { folder, f } = await begin();
  expect(f.file).toBe(join(folder, 'raw.mkv'));
  clip(f.file, 2);
  f.stdout.write('out_time_us=3000000\n');
  await wait(100);
  expect((await (await api('POST', '/recording/mode', { mode: 'fast' })).json()).mode).toBe('fast');
  f.stderr.write('Failed to capture image\n');
  f.finish(1);
  return { folder, view: await until('paused') };
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  out = join(repo, 'videos');
  mkdirSync(boardHome(), { recursive: true });
  writeFileSync(join(boardHome(), 'settings.json'), JSON.stringify({ recording: { enabled: true, fps: 30, quality: 'small', speed: 4, output: out, keepRaw: true } }));
  srv = await start({ repo });
});
afterEach(() => {
  vi.useRealTimers();
  fakes.quits = true;
});
afterAll(async () => {
  await srv.close();
  removeTemp(repo);
});

it.runIf(live)('a capture that exits by itself after writing a file is kept as a paused segment with the ffmpeg error, dropping marks past its end', async () => {
  const { folder, view } = await died();
  expect(view).toMatchObject({ state: 'paused', mode: 'regular', started: null, fastStretches: 0 });
  expect(Math.abs(view.elapsed - 2)).toBeLessThan(0.2);
  expect(view.error).toBe('ffmpeg exited with code 1\nFailed to capture image');
  const m = markers(folder);
  expect(m.paused).toBe(true);
  expect(m.segments).toHaveLength(1);
  expect(m.segments[0].file).toBe('raw.mkv');
  expect(m.segments[0].seconds).toBe(view.elapsed);
  expect(m.marks).toEqual([{ t: 0, mode: 'regular' }]);
  expect((await api('POST', '/recording/stop')).status).toBe(200);
  await until('idle');
}, 60_000);

it.runIf(live)('stop after the capture died renders 4x.mp4 from the recorded part and clears the error', async () => {
  const { folder } = await died();
  expect((await api('POST', '/recording/stop')).status).toBe(200);
  const done = await until('idle');
  expect(done).toMatchObject({ output: join(folder, '4x.mp4'), error: null });
  expect(Math.abs(duration(join(folder, '4x.mp4')) - 2)).toBeLessThan(0.2);
}, 60_000);

it.runIf(live)('resume after the capture died records raw-2.mkv in the same folder, and stop joins both', async () => {
  const { folder } = await died();
  const r = await api('POST', '/recording/resume');
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ state: 'recording', error: null });
  const f = fakes.list.at(-1)!;
  expect(f.file).toBe(join(folder, 'raw-2.mkv'));
  clip(f.file, 1);
  f.stdout.write('out_time_us=1000000\n');
  expect((await api('POST', '/recording/stop')).status).toBe(200);
  expect(await until('idle')).toMatchObject({ output: join(folder, '4x.mp4'), error: null });
  expect(readdirSync(folder).sort()).toEqual(['4x.mp4', 'markers.json', 'raw.mkv']);
  expect(Math.abs(duration(join(folder, '4x.mp4')) - 3)).toBeLessThan(0.2);
}, 60_000);

it.runIf(live)('a capture that exits by itself with nothing written ends idle with the error, as before', async () => {
  const { folder, f } = await begin();
  writeFileSync(f.file, '');
  f.stderr.write('Could not open output\n');
  f.finish(1);
  const done = await until('idle');
  expect(done.error).toBe('ffmpeg exited with code 1\nCould not open output');
  expect(markers(folder)).not.toHaveProperty('paused');
  expect(fakes.list.at(-1)).toBe(f);
}, 60_000);

it.runIf(live)('stop waits 60 s for a capture that ignores q before killing it, and the killed recording still renders', async () => {
  fakes.quits = false;
  const { folder, f } = await begin();
  clip(f.file, 3, false);
  f.stdout.write('out_time_us=3000000\n');
  await wait(100);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  stop();
  vi.advanceTimersByTime(59_999);
  expect(f.kills).toBe(0);
  vi.advanceTimersByTime(1);
  expect(f.kills).toBe(1);
  vi.useRealTimers();
  const done = await until('idle');
  expect(done).toMatchObject({ output: join(folder, '4x.mp4'), error: null });
  expect(Math.abs(duration(join(folder, '4x.mp4')) - 3)).toBeLessThan(0.2);
}, 60_000);
