import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { powershell } from './boards.js';
import { postDeliverable } from './deliverables.js';
import { changed, events, Refused, type Board } from './lifecycle.js';
import { configPath, readConfig } from './settings.js';

export interface Monitor { index: number; name: string; width: number; height: number; left: number; top: number; primary: boolean }
export interface Tools { ffmpeg: { path: string; version: string } | null; monitors: Monitor[]; output: string }
export type Mode = 'regular' | 'fast';
export interface Mark { t: number; mode: Mode }
export interface Segment { file: string; seconds: number }

const MONITORS_PS = `Add-Type -AssemblyName System.Windows.Forms
ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Screen]::AllScreens | % { [pscustomobject]@{ name = $_.DeviceName; width = $_.Bounds.Width; height = $_.Bounds.Height; left = $_.Bounds.X; top = $_.Bounds.Y; primary = $_.Primary } })`;
const CRF = { high: 18, medium: 23, small: 28 } as const;
const QUIT_MS = 10_000;
const PROGRESS_MS = 500;
const TAIL = 50;
const OUTPUT = () => join(homedir(), 'Videos', 'Kanban95');

function configured(repo?: string): string {
  try {
    const p = JSON.parse(readFileSync(configPath('settings', repo), 'utf8'))?.recording?.ffmpeg;
    return typeof p === 'string' && p.trim() ? p.trim() : 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

function ffmpeg(path: string): Promise<Tools['ffmpeg']> {
  return new Promise((ok) => {
    try {
      execFile(path, ['-version'], { timeout: 10_000, windowsHide: true }, (e, out) => {
        const line = String(out).split(/\r?\n/)[0].trim();
        ok(e || !line ? null : { path, version: /version (\S+)/.exec(line)?.[1] ?? line });
      });
    } catch {
      ok(null);
    }
  });
}

async function monitors(): Promise<Monitor[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { ok, out } = await powershell(MONITORS_PS);
    if (!ok) return [];
    const list = [JSON.parse(out)].flat() as Omit<Monitor, 'index'>[];
    return list.map((m, index) => ({ index, name: m.name, width: m.width, height: m.height, left: m.left, top: m.top, primary: m.primary }));
  } catch {
    return [];
  }
}

export async function tools(repo?: string): Promise<Tools> {
  const [f, m] = await Promise.all([ffmpeg(configured(repo)), monitors()]);
  return { ffmpeg: f, monitors: m, output: OUTPUT() };
}

export function stretches(marks: Mark[], total: number): { start: number; end: number; mode: Mode }[] {
  const kept = [{ t: 0, mode: 'regular' as Mode }, ...marks].filter((m, i, all) => m.t < total && (i === 0 || m.mode !== all[i - 1].mode));
  return kept.flatMap((m, i) => {
    const end = Math.min(kept[i + 1]?.t ?? total, total);
    return end > m.t ? [{ start: m.t, end, mode: m.mode }] : [];
  });
}

const sec = (n: number) => String(Number(n.toFixed(6)));

export function graph(marks: Mark[], totalSeconds: number, speed: number, fps: number): string {
  const parts = stretches(marks, totalSeconds);
  return [
    `[0:v]split=${parts.length}${parts.map((_, i) => `[s${i}]`).join('')}`,
    ...parts.map((p, i) => `[s${i}]trim=start=${sec(p.start)}:end=${sec(p.end)},setpts=(PTS-STARTPTS)/${p.mode === 'fast' ? `${speed},fps=${fps}` : 1}[v${i}]`),
    `${parts.map((_, i) => `[v${i}]`).join('')}concat=n=${parts.length}:v=1:a=0[out]`,
  ].join(';');
}

const length = (marks: Mark[], total: number, speed: number) =>
  stretches(marks, total).reduce((s, p) => s + (p.end - p.start) / (p.mode === 'fast' ? speed : 1), 0);

type Proc = { proc: ChildProcess; exited: Promise<number | null>; stderr: string[] };

function run(exe: string, args: string[], time: (seconds: number) => void): Proc {
  const stderr: string[] = [];
  const proc = spawn(exe, ['-hide_banner', '-nostats', '-loglevel', 'warning', '-progress', 'pipe:1', ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise<number | null>((ok) => {
    proc.once('exit', ok);
    proc.once('error', (e) => {
      stderr.push(e.message);
      ok(null);
    });
  });
  proc.stdin!.on('error', () => {});
  createInterface({ input: proc.stdout! }).on('line', (l) => {
    const m = /^out_time_us=(\d+)/.exec(l);
    if (m) time(Number(m[1]) / 1e6);
  });
  createInterface({ input: proc.stderr! }).on('line', (l) => {
    stderr.push(l);
    if (stderr.length > TAIL) stderr.shift();
  });
  return { proc, exited, stderr };
}

const failed = (p: Proc, code: number | null) => [`ffmpeg exited with code ${code}`, ...p.stderr].join('\n');

const probe = (exe: string, file: string) => new Promise<number | null>((ok) => {
  const ffprobe = exe === 'ffmpeg' ? 'ffprobe' : join(dirname(exe), `ffprobe${extname(exe)}`);
  execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30_000, windowsHide: true }, (e, out) => {
    const n = Number(String(out).trim());
    ok(!e && n > 0 ? n : null);
  });
});

const hasFilter = (exe: string, name: string) => new Promise<boolean>((ok) => {
  execFile(exe, ['-hide_banner', '-h', `filter=${name}`], { timeout: 10_000, windowsHide: true }, (e, out) => ok(!e && String(out).startsWith(`Filter ${name}`)));
});

async function input(exe: string, monitor: number, fps: number): Promise<string[]> {
  if (await hasFilter(exe, 'ddagrab')) return ['-f', 'lavfi', '-i', `ddagrab=output_idx=${monitor}:framerate=${fps},hwdownload,format=bgra`];
  const m = (await monitors())[monitor];
  if (!m) throw new Refused(`monitor ${monitor} not found`);
  return ['-f', 'gdigrab', '-framerate', String(fps), '-offset_x', String(m.left), '-offset_y', String(m.top), '-video_size', `${m.width}x${m.height}`, '-i', 'desktop'];
}

const pad = (n: number) => String(n).padStart(2, '0');
const stampOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
const RAW = 'raw.mkv';
const MARKERS = 'markers.json';

export function folderFor(dir: string, now: Date): string {
  let folder = join(dir, stampOf(now));
  for (let n = 2; existsSync(folder); n++) folder = join(dir, `${stampOf(now)} (${n})`);
  return folder;
}

type Rec = { folder: string; marks: Mark[]; speed: number; fps: number; segments: Segment[]; args: string[] | null };
type Capture = Proc & { file: string; stopping: boolean; halted: boolean; closed?: Promise<void> };

// ponytail: one recording per daemon, so two boards can record at once. A machine-wide lock would go in the running-registry
// entry (boards.ts register).
let state: 'idle' | 'recording' | 'paused' | 'rendering' = 'idle';
let starting = false;
let current: Mode = 'regular';
let rec: Rec | null = null;
let capture: Capture | null = null;
let encoder: ChildProcess | null = null;
let owner: Board | null = null;
let started: Date | null = null;
let elapsed = 0;
let clock = 0;
let progress: number | null = null;
let output: string | null = null;
let error: string | null = null;
let sent = 0;
let rendering: number | null = null;
let checked: string | null = null;

function speedOf(repo?: string): number | null {
  try {
    return readConfig('settings', repo).recording.speed;
  } catch {
    return null;
  }
}

export function view(repo?: string) {
  return { state, mode: current, started: started?.toISOString() ?? null, elapsed, speed: rec?.speed ?? rendering ?? speedOf(repo), progress, output, error, fastStretches: rec?.marks.filter((m) => m.mode === 'fast').length ?? 0 };
}

function emit() {
  sent = Date.now();
  events.emit('event', { recording: view(owner?.repo) });
}

const save = (r: Rec) => writeFileSync(join(r.folder, MARKERS), JSON.stringify({ speed: r.speed, fps: r.fps, marks: r.marks, ...(r.segments.length ? { paused: true, segments: r.segments } : {}) }, null, 2));
const exeOf = (repo?: string) => readConfig('settings', repo).recording.ffmpeg || 'ffmpeg';

function capturing(r: Rec, exe: string, file: string) {
  const raw = run(exe, [...r.args!, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(r.fps), '-an', '-stats_period', '0.1', '-n', join(r.folder, file)], (t) => {
    if (capture === c) clock = t;
  });
  const c: Capture = { ...raw, file, stopping: false, halted: false };
  state = 'recording';
  capture = c;
  current = 'regular';
  started = new Date();
  clock = 0;
  progress = null;
  output = null;
  error = null;
  void c.exited.then((code) => {
    if (c.stopping || capture !== c) return;
    capture = null;
    rec = null;
    state = 'idle';
    started = null;
    error = failed(c, code);
    emit();
  });
}

const PAUSED = 'a paused recording exists: resume or stop it';

export async function start(board: Board) {
  if (state === 'paused') throw new Refused(PAUSED);
  const cfg = readConfig('settings', board.repo).recording;
  if (!cfg.enabled) throw new Refused('recording is off: set recording.enabled to true in settings.json');
  if (process.platform !== 'win32') throw new Refused('recording is Windows only');
  const busy = () => {
    if (starting || state !== 'idle') throw new Refused(state === 'rendering' ? 'a render is running' : state === 'paused' ? PAUSED : 'already recording');
  };
  busy();
  starting = true;
  let args: string[];
  try {
    const exe = cfg.ffmpeg || 'ffmpeg';
    if (!(await ffmpeg(exe))) throw new Refused(`ffmpeg not found: ${exe}`);
    args = await input(exe, cfg.monitor, cfg.fps);
  } finally {
    starting = false;
  }
  busy();
  const dir = cfg.output || OUTPUT();
  const folder = folderFor(dir, new Date());
  try {
    mkdirSync(folder, { recursive: true });
  } catch (e) {
    throw new Refused(`cannot create ${folder}: ${(e as Error).message}`);
  }
  const r: Rec = { folder, marks: [{ t: 0, mode: 'regular' }], speed: cfg.speed, fps: cfg.fps, segments: [], args };
  save(r);
  rec = r;
  owner = board;
  elapsed = 0;
  capturing(r, cfg.ffmpeg || 'ffmpeg', RAW);
  emit();
  return view(board.repo);
}

export function mode(m: Mode, repo?: string) {
  if (state === 'paused') throw new Refused('the recording is paused: resume it first');
  const r = rec;
  if (!r || !capture || capture.stopping || state !== 'recording') throw new Refused('not recording');
  if (r.marks.at(-1)!.mode === m) return view(repo);
  r.marks.push({ t: elapsed + clock, mode: m });
  save(r);
  current = m;
  emit();
  return view(repo);
}

async function quit(c: Capture) {
  c.proc.stdin!.end('q');
  const timer = setTimeout(() => c.proc.kill(), QUIT_MS);
  await c.exited;
  clearTimeout(timer);
}

function close(c: Capture, r: Rec) {
  c.stopping = true;
  c.closed ??= (async () => {
    const ran = clock;
    await quit(c);
    const seconds = (await probe(exeOf(owner?.repo), join(r.folder, c.file))) ?? Math.max(ran, clock);
    r.segments.push({ file: c.file, seconds });
    elapsed += seconds;
    clock = 0;
    started = null;
    save(r);
  })();
  return c.closed;
}

export async function pause(repo?: string) {
  const c = capture;
  const r = rec;
  if (!c || !r || c.stopping || state !== 'recording') throw new Refused(state === 'paused' ? 'already paused' : 'not recording');
  await close(c, r);
  if (capture !== c) return view(repo);
  capture = null;
  state = 'paused';
  emit();
  return view(repo);
}

export async function resume(board: Board) {
  const r = rec;
  if (starting || state !== 'paused' || !r) throw new Refused(state === 'recording' ? 'already recording' : 'nothing is paused');
  const exe = exeOf(board.repo);
  starting = true;
  try {
    if (!(await ffmpeg(exe))) throw new Refused(`ffmpeg not found: ${exe}`);
    r.args ??= await input(exe, readConfig('settings', board.repo).recording.monitor, r.fps);
  } finally {
    starting = false;
  }
  if (state !== 'paused' || rec !== r) throw new Refused('nothing is paused');
  let n = 2;
  while (existsSync(join(r.folder, `raw-${n}.mkv`))) n++;
  if (r.marks.at(-1)!.mode === 'fast') r.marks.push({ t: elapsed, mode: 'regular' });
  save(r);
  owner = board;
  capturing(r, exe, `raw-${n}.mkv`);
  emit();
  return view(board.repo);
}

export function loadPaused(board: Board) {
  let dir: string;
  try {
    dir = readConfig('settings', board.repo).recording.output || OUTPUT();
  } catch {
    return;
  }
  if (dir === checked) return;
  checked = dir;
  if (starting || state !== 'idle') return;
  let found: { r: Rec; at: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, MARKERS);
      try {
        const m = JSON.parse(readFileSync(file, 'utf8'));
        if (m?.paused !== true || !Array.isArray(m.segments) || !m.segments.length || !Array.isArray(m.marks)) continue;
        const at = statSync(file).mtimeMs;
        if (!found || at > found.at) found = { r: { folder: join(dir, name), marks: m.marks, speed: m.speed, fps: m.fps, segments: m.segments, args: null }, at };
      } catch {}
    }
  } catch {
    return;
  }
  if (!found) return;
  const r = found.r;
  elapsed = r.segments.reduce((s, g) => s + g.seconds, 0);
  r.marks = r.marks.filter((m) => m.t <= elapsed);
  rec = r;
  owner = board;
  state = 'paused';
  current = r.marks.at(-1)?.mode ?? 'regular';
  started = null;
  progress = null;
  error = null;
  emit();
}

async function joined(r: Rec, exe: string): Promise<string> {
  const raw = join(r.folder, RAW);
  if (r.segments.length > 1) {
    const list = join(r.folder, 'list.txt');
    const tmp = join(r.folder, 'joined.mkv');
    writeFileSync(list, r.segments.map((s) => `file '${s.file}'\n`).join(''));
    const p = run(exe, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', tmp], () => {});
    const code = await p.exited;
    rmSync(list, { force: true });
    if (code !== 0) {
      rmSync(tmp, { force: true });
      throw new Error(failed(p, code));
    }
    for (const s of r.segments) rmSync(join(r.folder, s.file), { force: true });
    renameSync(tmp, raw);
  }
  r.segments = [];
  save(r);
  return raw;
}

export function stop(repo?: string) {
  const c = capture;
  const r = rec;
  if (!r || (state !== 'recording' && state !== 'paused') || c?.stopping) throw new Refused('not recording');
  if (c) c.stopping = true;
  state = 'rendering';
  progress = 0;
  emit();
  void (async () => {
    if (c) {
      await close(c, r);
      if (c.halted) return;
      capture = null;
    }
    rec = null;
    let raw: string;
    try {
      raw = await joined(r, exeOf(owner!.repo));
    } catch (e) {
      error = (e as Error).message;
      state = 'idle';
      progress = null;
      emit();
      return;
    }
    await render(owner!, raw, join(r.folder, MARKERS), readConfig('settings', owner!.repo).recording.speed, elapsed);
  })();
  return view(repo);
}

export function renderAgain(board: Board, raw: string, speed: number) {
  if (starting || state !== 'idle') throw new Refused(state === 'rendering' ? 'a render is running' : state === 'paused' ? PAUSED : 'a recording is running');
  const layout = `expected <recording folder>\\${RAW} with ${MARKERS} beside it`;
  if (!isAbsolute(raw) || basename(raw) !== RAW || !existsSync(raw)) throw new Refused(`${raw} is not a raw recording (${layout})`);
  const markers = join(dirname(raw), MARKERS);
  if (!existsSync(markers)) throw new Refused(`${MARKERS} is missing beside ${raw} (${layout})`);
  owner = board;
  state = 'rendering';
  started = null;
  elapsed = 0;
  progress = 0;
  output = null;
  error = null;
  rendering = speed;
  emit();
  void render(board, raw, markers, speed);
  return view(board.repo);
}

async function render(board: Board, raw: string, markers: string, speed: number, seconds?: number): Promise<void> {
  rendering = speed;
  try {
    const cfg = readConfig('settings', board.repo).recording;
    const out = join(dirname(raw), `${Math.round(speed)}x.mp4`);
    const exe = cfg.ffmpeg || 'ffmpeg';
    const { marks } = JSON.parse(readFileSync(markers, 'utf8')) as { marks: Mark[] };
    const total = (await probe(exe, raw)) ?? seconds;
    if (!total) throw new Error(`cannot read the length of ${basename(raw)}`);
    const expected = length(marks, total, speed);
    const p = run(exe, ['-y', '-i', raw, '-filter_complex', graph(marks, total, speed, cfg.fps), '-map', '[out]', '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF[cfg.quality]), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out], (t) => {
      progress = Math.min(1, t / expected);
      if (Date.now() - sent >= PROGRESS_MS) emit();
    });
    encoder = p.proc;
    const code = await p.exited;
    encoder = null;
    if (code !== 0) {
      rmSync(out, { force: true });
      throw new Error(failed(p, code));
    }
    postDeliverable(board.db, out, null, `Recording ${basename(dirname(raw))} ${Math.round(speed)}x`);
    changed(null);
    if (!cfg.keepRaw) for (const f of [raw, markers]) rmSync(f, { force: true });
    output = out;
  } catch (e) {
    error = (e as Error).message;
  }
  state = 'idle';
  started = null;
  progress = null;
  rendering = null;
  emit();
}

export async function halt() {
  const c = capture;
  if (c && rec) {
    c.halted = true;
    await close(c, rec);
  }
  if (c || state === 'paused') {
    capture = null;
    rec = null;
    state = 'idle';
    started = null;
    elapsed = 0;
  }
  checked = null;
  encoder?.kill();
}
