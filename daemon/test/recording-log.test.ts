import './home.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { start } from '../src/server.ts';
import { boardHome } from '../src/settings.ts';
import { removeTemp } from './home.ts';

type Fake = { file: string; stdout: NodeJS.WritableStream };
const fakes = vi.hoisted(() => ({ list: [] as Fake[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const capture = (file: string) => {
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    proc.stdin.on('data', (d) => {
      if (!String(d).includes('q')) return;
      setImmediate(() => {
        proc.stdout.end();
        proc.stderr.end();
        proc.emit('exit', 0);
      });
    });
    Object.assign(proc, { kill: () => true });
    fakes.list.push({ file, stdout: proc.stdout });
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
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const live = hasFfmpeg && process.platform === 'win32';

const api = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idle = async () => {
  for (let i = 0; i < 600; i++) {
    const body = await (await api('GET', '/recording')).json();
    if (body.state === 'idle') return body;
    await wait(100);
  }
  throw new Error('still busy after 60 s');
};
const settings = (keepRaw: boolean) =>
  writeFileSync(join(boardHome(), 'settings.json'), JSON.stringify({ recording: { enabled: true, fps: 30, quality: 'small', speed: 4, output: out, keepRaw } }));
const ffmpeg = (args: string[], file: string) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, file], { windowsHide: true });
const video = (file: string, seconds: number) => ffmpeg(['-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=30`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'], file);
const folder = (name: string) => {
  const dir = join(repo, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'markers.json'), JSON.stringify({ speed: 4, fps: 30, marks: [{ t: 0, mode: 'regular' }, { t: 1, mode: 'fast' }] }));
  return { dir, raw: join(dir, 'raw.mkv') };
};
const log = (dir: string) => readFileSync(join(dir, 'recording.log'), 'utf8');
const stamped = (text: string) => text.split('\n').filter((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(l)).map((l) => l.slice(25));

const record = async () => {
  const before = new Set(existsSync(out) ? readdirSync(out) : []);
  expect((await api('POST', '/recording/start')).status).toBe(200);
  const [name] = readdirSync(out).filter((f) => !before.has(f));
  const dir = join(out, name);
  const f = fakes.list.at(-1)!;
  expect(f.file).toBe(join(dir, 'raw.mkv'));
  video(f.file, 3);
  f.stdout.write('out_time_us=3000000\n');
  return dir;
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  out = join(repo, 'videos');
  mkdirSync(boardHome(), { recursive: true });
  settings(true);
  srv = await start({ repo });
});
afterAll(async () => {
  await srv.close();
  removeTemp(repo);
});

it.runIf(live)('a recorded, switched, stopped and rendered session leaves recording.log with the start arguments, stop, the capture exit code and the mp4', async () => {
  settings(true);
  const dir = await record();
  expect((await api('POST', '/recording/mode', { mode: 'fast' })).status).toBe(200);
  expect((await api('POST', '/recording/stop')).status).toBe(200);
  const mp4 = join(dir, '4x.mp4');
  expect(await idle()).toMatchObject({ output: mp4, error: null });
  const lines = stamped(log(dir));
  const first = lines[0];
  expect(first).toMatch(/^start raw\.mkv: ffmpeg /);
  expect(first).toContain(' -f lavfi -i ');
  expect(first.endsWith(` -stats_period 0.1 -n ${JSON.stringify(join(dir, 'raw.mkv'))}`)).toBe(true);
  expect(lines).toContain('stop');
  expect(lines).toContain('capture raw.mkv: ffmpeg exited with code 0');
  expect(lines.find((l) => l.startsWith('length raw.mkv: '))).toMatch(/s from ffprobe$/);
  expect(lines.find((l) => l.startsWith('render: '))).toMatch(/^render: speed 4x, total 3(\.\d+)? s$/);
  expect(lines).toContain('render: ffmpeg exited with code 0');
  expect(lines.at(-1)).toBe(`render done: ${mp4}`);
}, 60_000);

it.runIf(hasFfmpeg)('a failed render writes the ffmpeg exit code and its stderr to recording.log', async () => {
  settings(true);
  const { dir, raw } = folder('no-video');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'flac'], raw);
  expect((await api('POST', '/recording/render', { raw })).status).toBe(200);
  const done = await idle();
  expect(done.output).toBeNull();
  const text = log(dir);
  const code = /render: ffmpeg exited with code (-?\d+)/.exec(text);
  expect(code).not.toBeNull();
  expect(Number(code![1])).not.toBe(0);
  const stderr = done.error.split('\n').slice(1).filter(Boolean);
  expect(stderr.length).toBeGreaterThan(0);
  for (const l of stderr) expect(text).toContain(`  | ${l}`);
  expect(stamped(text).at(-1)).toMatch(/^render failed: ffmpeg exited with code/);
}, 60_000);

it.runIf(hasFfmpeg)('with keepRaw off recording.log stays in the folder after a successful render, and the render appends to the earlier log', async () => {
  settings(false);
  const { dir, raw } = folder('drop');
  video(raw, 5);
  writeFileSync(join(dir, 'recording.log'), 'earlier\n');
  expect((await api('POST', '/recording/render', { raw })).status).toBe(200);
  expect(await idle()).toMatchObject({ output: join(dir, '4x.mp4'), error: null });
  expect(readdirSync(dir).sort()).toEqual(['4x.mp4', 'recording.log']);
  const text = log(dir);
  expect(text.startsWith('earlier\n')).toBe(true);
  expect(stamped(text).at(-1)).toBe(`render done: ${join(dir, '4x.mp4')}`);
}, 60_000);

it.runIf(hasFfmpeg)('render again still renders when recording.log is a folder', async () => {
  settings(true);
  const { dir, raw } = folder('blocked-render');
  video(raw, 5);
  mkdirSync(join(dir, 'recording.log'));
  expect((await api('POST', '/recording/render', { raw })).status).toBe(200);
  expect(await idle()).toMatchObject({ output: join(dir, '4x.mp4'), error: null });
  expect(statSync(join(dir, 'recording.log')).isDirectory()).toBe(true);
}, 60_000);

it.runIf(live)('a recording still switches, stops and renders when recording.log is a folder', async () => {
  settings(true);
  const dir = await record();
  rmSync(join(dir, 'recording.log'));
  mkdirSync(join(dir, 'recording.log'));
  expect((await api('POST', '/recording/mode', { mode: 'fast' })).status).toBe(200);
  expect((await api('POST', '/recording/stop')).status).toBe(200);
  expect(await idle()).toMatchObject({ output: join(dir, '4x.mp4'), error: null });
  expect(statSync(join(dir, 'recording.log')).isDirectory()).toBe(true);
}, 60_000);
