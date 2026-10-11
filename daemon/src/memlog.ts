import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';

export type Proc = { pid: number; ppid: number; name: string; ws: number };
export type Snapshot = { procs: Proc[]; commit?: { used: number; limit: number } };
export type Live = { key: number; ticketId: number | null; pty: { pid: number } };

export const MEMLOG_EVERY = 30_000;
export const MEMLOG_KEEP = 24 * 60 * 60 * 1000;
const TRIM_EVERY = 120;
const MB = 1024 * 1024;

const PS_SNAPSHOT = `$os = Get-CimInstance Win32_OperatingSystem
"C $($os.TotalVirtualMemorySize) $($os.FreeVirtualMemory)"
Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize) $($_.Name)" }`;

function snapshot(): Promise<Snapshot> {
  const win = process.platform === 'win32';
  const [cmd, argv] = win
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SNAPSHOT]]
    : ['ps', ['-eo', 'pid=,ppid=,rss=,comm=']];
  return new Promise((ok, fail) => execFile(cmd, argv, { windowsHide: true, timeout: 25_000, maxBuffer: 64 * MB }, (e, out) => {
    if (e) return fail(e);
    const s: Snapshot = { procs: [] };
    for (const line of out.split(/\r?\n/)) {
      const c = /^C (\d+) (\d+)/.exec(line);
      if (c) {
        s.commit = { limit: Number(c[1]) * 1024, used: (Number(c[1]) - Number(c[2])) * 1024 };
        continue;
      }
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) s.procs.push({ pid: Number(m[1]), ppid: Number(m[2]), ws: Number(m[3]) * (win ? 1 : 1024), name: m[4].trim() });
    }
    ok(s);
  }));
}

export const sources = { free: freemem, total: totalmem, rss: () => process.memoryUsage.rss(), snapshot };

let file: string | undefined;
let live: () => Iterable<Live> = () => [];
let samples = 0;

const mb = (n: number) => `${Math.round(n / MB)}MB`;
export const who = (s: Pick<Live, 'key' | 'ticketId'>) => (s.ticketId !== null ? `t${s.ticketId}` : `s${s.key}`);
const write = (text: string) => {
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch (e) {
    console.error('[memlog]', (e as Error).message);
  }
};

export function mark(event: string, subject: string, detail?: string) {
  write([event, subject, detail].filter(Boolean).join(' '));
}

export function trim(now = Date.now()) {
  if (!file || !existsSync(file)) return;
  const cutoff = now - MEMLOG_KEEP;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const kept = lines.filter((l) => Date.parse(l.slice(0, l.indexOf(' '))) >= cutoff);
  if (kept.length !== lines.length) writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '');
}

function tree(procs: Proc[], root: number) {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const seen = new Set<number>();
  const stack = procs.filter((p) => p.pid === root);
  let ws = 0;
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    ws += p.ws;
    for (const k of kids.get(p.pid) ?? []) if (k.pid !== p.pid) stack.push(k);
  }
  return { ws, n: seen.size };
}

export async function sample() {
  if (!file) return;
  const fields = [`free=${mb(sources.free())}`, `total=${mb(sources.total())}`];
  let snap: Snapshot | undefined;
  try {
    snap = await sources.snapshot();
  } catch (e) {
    fields.push(`snapshot-error=${JSON.stringify((e as Error).message.split('\n')[0])}`);
  }
  if (snap?.commit) fields.push(`commit=${mb(snap.commit.used)}/${mb(snap.commit.limit)}`);
  fields.push(`daemon=${mb(sources.rss())}`);
  if (snap) {
    fields.push(`procs=${snap.procs.length}`);
    for (const s of live()) {
      const t = tree(snap.procs, s.pty.pid);
      fields.push(`${who(s)}=${mb(t.ws)}/${t.n}`);
    }
    const byName = new Map<string, { ws: number; n: number }>();
    for (const p of snap.procs) {
      const x = byName.get(p.name) ?? { ws: 0, n: 0 };
      byName.set(p.name, { ws: x.ws + p.ws, n: x.n + 1 });
    }
    const top = [...byName].sort((a, b) => b[1].ws - a[1].ws).slice(0, 3);
    fields.push(`top=${top.map(([name, x]) => `${name}:${mb(x.ws)}/${x.n}`).join(',')}`);
  }
  if (!file) return;
  write(`mem ${fields.join(' ')}`);
  if (++samples % TRIM_EVERY === 0) trim();
}

export function startMemoryLog(repo: string, list: () => Iterable<Live>): () => void {
  file = join(repo, '.kanban95', 'memory.log');
  live = list;
  samples = 0;
  trim();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void sample().finally(() => (busy = false));
  }, MEMLOG_EVERY).unref();
  return () => {
    clearInterval(timer);
    file = undefined;
    live = () => [];
  };
}
