import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { ownEntry, powershell, running } from './boards.js';
import { postDeliverable } from './deliverables.js';
import { changed, events, Refused, type Board } from './lifecycle.js';
import { boardHome, configPath, dataHome, readConfig } from './settings.js';

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

// One recording per machine. The daemon recording, paused or rendering owns it and writes <data folder>/recording.json on
// every change; every other daemon shows that file's view and forwards mode, pause, resume and stop to the owner's
// key-checked route (docs/ARCHITECTURE.md -> REST).
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
let here: Board | null = null;
let poll: NodeJS.Timeout | null = null;
let seen = '';
let shown = '';

type View = ReturnType<typeof local>;
type Shared = View & { pid: number | null; port: number | null; repo: string | null };
const SHARED = 'recording.json';

function readShared(): { raw: string; s: Shared | null } {
  let raw = '';
  try {
    raw = readFileSync(join(boardHome(), SHARED), 'utf8');
  } catch {
    return { raw, s: null };
  }
  try {
    const s = JSON.parse(raw);
    return { raw, s: s && typeof s === 'object' && typeof s.state === 'string' ? s : null };
  } catch {
    return { raw, s: null };
  }
}

const ownerOf = (s: Shared | null) => (s && Number.isInteger(s.pid) && s.pid !== process.pid ? running().find((e) => e.pid === s.pid) ?? null : null);
const nameOf = (s: Shared) => basename(s.repo ?? '') || `pid ${s.pid}`;
const active = () => starting || state !== 'idle';

function foreign() {
  const { s } = readShared();
  const entry = ownerOf(s);
  return entry ? { s: s!, entry } : null;
}

function writeShared(v: Shared) {
  try {
    const file = join(dataHome(), SHARED);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(v));
    try {
      renameSync(tmp, file);
    } catch {
      rmSync(tmp, { force: true });
      writeFileSync(file, JSON.stringify(v));
    }
  } catch {}
}

function publish() {
  if (state !== 'idle') return writeShared({ ...local(owner?.repo), pid: process.pid, port: ownEntry()?.port ?? null, repo: owner?.repo ?? here?.repo ?? null });
  if (readShared().s?.pid !== process.pid) return;
  try {
    rmSync(join(boardHome(), SHARED), { force: true });
  } catch {}
}

function busyElsewhere(f: ReturnType<typeof foreign>) {
  if (!f) return;
  throw new Refused(f.s.state === 'rendering' ? `a render is running on ${nameOf(f.s)}` : `${nameOf(f.s)} is recording`);
}

// ponytail: a 1 s poll of recording.json, so another board's change shows up to 1 s late and every daemon reads the file
// and the running registry once a second. fs.watch on the data folder would make it immediate.
function look() {
  const { raw, s } = readShared();
  if (raw && !s) return;
  if (state === 'paused' && !capture && !starting && ownerOf(s)) {
    rec = null;
    state = 'idle';
    elapsed = 0;
    current = 'regular';
    emit();
  }
  if (raw !== seen) {
    seen = raw;
    if (here && s?.state === 'paused' && s.pid !== process.pid && !ownerOf(s)) {
      checked = null;
      loadPaused(here);
    }
  }
  if (active()) return;
  const v = JSON.stringify(view(here?.repo));
  if (v === shown) return;
  shown = v;
  events.emit('event', { recording: JSON.parse(v) });
}

function share(board: Board) {
  here = board;
  if (poll) return;
  seen = readShared().raw;
  poll = setInterval(look, 1000);
  poll.unref();
}

export async function relay(action: 'mode' | 'pause' | 'resume' | 'stop', body: { mode?: Mode } = {}): Promise<View | null> {
  if (active()) return null;
  const f = foreign();
  if (!f) return null;
  const name = nameOf(f.s);
  if (!f.entry.key) throw new Refused(`${name} runs an older Kanban95 that cannot share its recording`);
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${f.entry.port}/api/recording/relay/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-K95-Key': f.entry.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Refused(`${name} did not answer: ${(e as Error).message}`);
  }
  const out = await r.json().catch(() => ({})) as View & { error?: string };
  if (!r.ok) throw new Refused(r.status === 409 && out.error ? out.error : `${name} refused (${r.status}): ${out.error ?? r.statusText}`);
  return out;
}

function speedOf(repo?: string): number | null {
  try {
    return readConfig('settings', repo).recording.speed;
  } catch {
    return null;
  }
}

export function view(repo?: string): View {
  const f = active() ? null : foreign();
  if (!f) return local(repo);
  const { pid: _p, port: _o, repo: _r, ...v } = f.s;
  return v;
}

function local(repo?: string) {
  return { state, mode: current, started: started?.toISOString() ?? null, elapsed, speed: rec?.speed ?? rendering ?? speedOf(repo), progress, output, error, fastStretches: rec?.marks.filter((m) => m.mode === 'fast').length ?? 0 };
}

function emit() {
  sent = Date.now();
  publish();
  const v = view(owner?.repo ?? here?.repo);
  shown = JSON.stringify(v);
  events.emit('event', { recording: v });
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
    busyElsewhere(foreign());
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
  share(board);
  let dir: string;
  try {
    dir = readConfig('settings', board.repo).recording.output || OUTPUT();
  } catch {
    return;
  }
  if (dir === checked) return;
  checked = dir;
  if (active() || foreign()) return;
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
  busyElsewhere(foreign());
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

async function repaired(exe: string, raw: string): Promise<{ seconds: number | null; tail: string[] }> {
  const seconds = await probe(exe, raw);
  if (seconds) return { seconds, tail: [] };
  const tmp = join(dirname(raw), 'raw-repair.mkv');
  const p = run(exe, ['-y', '-i', raw, '-c', 'copy', tmp], () => {});
  const code = await p.exited;
  const fixed = code === 0 ? await probe(exe, tmp) : null;
  if (!fixed) {
    rmSync(tmp, { force: true });
    return { seconds: null, tail: [`repair: ${failed(p, code)}`] };
  }
  try {
    renameSync(raw, join(dirname(raw), 'raw-broken.mkv'));
  } catch (e) {
    rmSync(tmp, { force: true });
    return { seconds: null, tail: [`repair: cannot rename ${basename(raw)} (is it open in another program?): ${(e as Error).message}`] };
  }
  renameSync(tmp, raw);
  return { seconds: fixed, tail: [] };
}

async function render(board: Board, raw: string, markers: string, speed: number, seconds?: number): Promise<void> {
  rendering = speed;
  try {
    const cfg = readConfig('settings', board.repo).recording;
    const out = join(dirname(raw), `${Math.round(speed)}x.mp4`);
    const exe = cfg.ffmpeg || 'ffmpeg';
    const { marks } = JSON.parse(readFileSync(markers, 'utf8')) as { marks: Mark[] };
    const fixed = await repaired(exe, raw);
    const total = fixed.seconds ?? seconds;
    if (!total) throw new Error([`cannot read the length of ${basename(raw)}`, ...fixed.tail].join('\n'));
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
    writeShared({ ...local(owner?.repo), state: 'paused', started: null, pid: null, port: null, repo: null });
    capture = null;
    rec = null;
    state = 'idle';
    started = null;
    elapsed = 0;
  }
  checked = null;
  if (poll) clearInterval(poll);
  poll = null;
  here = null;
  seen = shown = '';
  encoder?.kill();
}
