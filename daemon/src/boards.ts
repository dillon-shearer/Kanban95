// The other boards on this machine (Start → Projects): the running registry ~/.kanban95/running/<pid>.json, and opening
// or focusing another project's board. One daemon per process, so the pid names the entry.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { boardHome, dataHome, gone, localHome, normal, readProjects, same } from './settings.js';

interface Entry { pid: number; repo: string; port: number; started: string; shell: number | null; agents: number; attention: number; key?: string }

const runningDir = () => join(boardHome(), 'running');
export const entryPath = (pid: number) => join(runningDir(), `${pid}.json`);
let own: Entry | null = null;

/** On daemon start, once it has its port. Returns the removal, which close() calls. */
export function register(repo: string, port: number, shell: number | null): () => void {
  const file = entryPath(process.pid);
  mkdirSync(join(dataHome(), 'running'), { recursive: true });
  own = { pid: process.pid, repo: normal(repo), port, started: new Date().toISOString(), shell, agents: 0, attention: 0, key: randomBytes(32).toString('hex') };
  writeFileSync(file, JSON.stringify(own) + '\n');
  running();
  if (!same(normal(localHome()), normal(boardHome()))) live(join(localHome(), 'running'));
  return () => {
    own = null;
    rmSync(file, { force: true });
  };
}

export function countBoard(agents: number, attention: number): void {
  if (!own || (own.agents === agents && own.attention === attention)) return;
  own.agents = agents;
  own.attention = attention;
  try { writeFileSync(entryPath(own.pid), JSON.stringify(own) + '\n'); } catch {}
}

const digest = (s: string) => createHash('sha256').update(s).digest();
export const keyOk = (given: unknown) => typeof given === 'string' && !!own?.key && timingSafeEqual(digest(given), digest(own.key));

/** EPERM: the pid exists but belongs to someone else, so it is alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Every live board. An entry whose pid is dead (a daemon killed with its shell never ran close()) is deleted, as is one
 * that does not parse.
 * ponytail: Windows reuses pids, so a stale entry whose pid now belongs to another process reads as running until that
 * process ends; checking the process's start time against `started` would close that.
 */
export const running = (): Entry[] => live(runningDir());

function live(dir: string): Entry[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const file = join(dir, n);
    let e: Entry;
    try {
      e = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      rmSync(file, { force: true });
      return [];
    }
    if (!Number.isInteger(e.pid) || !alive(e.pid)) {
      rmSync(file, { force: true });
      return [];
    }
    return [e];
  });
}

/** `{ <project path>: true | false }` for every project in projects.json. */
export function runningMap(): Record<string, boolean> {
  const live = running();
  return Object.fromEntries(readProjects().map((p) => [p.path, live.some((e) => same(e.repo, p.path))]));
}

export function missingMap(): Record<string, boolean> {
  return Object.fromEntries(readProjects().map((p) => [p.path, gone(p.path)]));
}

function sumMap(key: 'agents' | 'attention'): Record<string, number> {
  const live = running();
  return Object.fromEntries(readProjects().flatMap((p) => {
    const on = live.filter((e) => same(e.repo, p.path));
    return on.length ? [[p.path, on.reduce((n, e) => n + (Number.isInteger(e[key]) ? e[key] : 0), 0)]] : [];
  }));
}
export const agentsMap = () => sumMap('agents');
export const attentionMap = () => sumMap('attention');

export function hostedMap(shell: number | null | undefined): Record<string, boolean> {
  const live = running();
  return Object.fromEntries(readProjects().map((p) => [p.path, shell != null && live.some((e) => same(e.repo, p.path) && e.shell === shell)]));
}

export interface Filing { from: string; title: string; body: string; criteria: string; tags: string[] }

export function registeredBoard(project: string): { repo: string; name: string; entry?: Entry; names: string } {
  const list = readProjects();
  const names = list.map((p) => basename(p.path)).sort().join(', ') || 'none';
  const hits = isAbsolute(project) ? list.filter((p) => same(p.path, normal(project))) : list.filter((p) => same(basename(p.path), project));
  if (hits.length > 1) throw new Error(`${project} names ${hits.length} projects; give the absolute path. Registered boards: ${names}`);
  if (!hits.length) throw new Error(`${project} is not in projects.json. Registered boards: ${names}`);
  const repo = hits[0].path;
  const name = basename(repo);
  const entry = running().find((e) => same(e.repo, repo));
  if (!entry && gone(repo)) throw new Error(`${name} is missing: its folder ${repo} was deleted or moved. Registered boards: ${names}`);
  return { repo, name, entry, names };
}

export async function fileOn(entry: Entry, name: string, f: Filing): Promise<unknown> {
  if (!entry.key) throw new Error(`${name} runs an older Kanban95 that cannot take a filed ticket`);
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${entry.port}/api/boards/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-K95-Key': entry.key },
      body: JSON.stringify(f),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`${name} did not answer: ${(e as Error).message}`);
  }
  const out = await r.json().catch(() => ({})) as { error?: string };
  if (!r.ok) throw new Error(`${name} refused the ticket (${r.status}): ${out.error ?? r.statusText}`);
  return out;
}

type Verb = 'open' | 'switch' | 'popout' | 'dock' | 'close' | 'restart' | 'check' | 'checknow' | 'update' | 'pick' | 'repo';

export function tellShell(verb: Verb, path: string, rest = ''): void {
  process.stdout.write(`KANBAN95 ${verb}=${path && normal(path)}${rest && ' ' + rest}\n`);
}

export function askShell(board: { shell?: boolean; shellId?: number | null }, verb: Verb, path: unknown): { name: string } {
  const repo = listed(path);
  const name = basename(repo);
  if (!board.shell) throw new Error('this board does not run under a shell');
  const live = running().filter((e) => same(e.repo, repo));
  const hosted = board.shellId != null && live.some((e) => e.shell === board.shellId);
  if (verb === 'open') {
    if (hosted) verb = 'switch';
    else if (gone(repo)) throw new Error(`${name} is missing: its folder ${repo} was deleted or moved`);
    else if (live.length) throw new Error(`${name} is running in another window`);
  } else if (!hosted) throw new Error(`${name} is not hosted by this shell`);
  tellShell(verb, repo);
  return { name };
}

export function othersHosted(shell: number | null | undefined): string[] {
  return shell == null ? [] : running().filter((e) => e.shell === shell && e.pid !== process.pid).map((e) => e.repo);
}

export class NotListed extends Error {}
/** The projects.json entry for `path`; anything else is refused, so a request can only name a repo the operator listed. */
function listed(path: unknown): string {
  if (typeof path !== 'string') throw new NotListed('path must be a string');
  const p = readProjects().find((x) => same(x.path, normal(path)));
  if (!p) throw new NotListed(`${path} is not in projects.json`);
  return p.path;
}

/** Starts `cmd args` outside this board's process tree. Tests replace `boards.start` and nothing is started. */
export const boards = { start: startDetached };

/**
 * Not running: start a new board on it. From a repo checkout (the install root has daemon/src), the shell `npm run dev`
 * built, as it is: `cargo run` relinks that binary every time (tauri-build watches the missing shell/capabilities, so its
 * build script always reruns) and on Windows fails while this board holds it open. Installed, the shell exe next to `app/`.
 */
export async function openProject(path: unknown, root: string): Promise<{ name: string }> {
  const repo = listed(path);
  if (running().some((e) => same(e.repo, repo))) throw new Error(`${basename(repo)} is already running`);
  if (gone(repo)) throw new Error(`${basename(repo)} is missing: its folder ${repo} was deleted or moved`);
  const win = process.platform === 'win32';
  if (existsSync(join(root, 'daemon', 'src'))) {
    // ponytail: the dev build `cargo run` makes; a board run from a release build in a checkout is not looked for.
    const exe = join(root, 'shell', 'target', 'debug', win ? 'kanban95-shell.exe' : 'kanban95-shell');
    if (!existsSync(exe)) throw new Error(`no shell build at ${exe}: run npm run dev once`);
    await boards.start(exe, [repo]);
  } else {
    // ponytail: the installed exe is found as the one .exe beside app/ other than the uninstaller; Windows only, as only
    // an NSIS installer is built. A macOS bundle would need `open -n -a <bundle> --args <path>`.
    const dir = dirname(resolve(root));
    const exe = win ? readdirSync(dir).find((f) => /\.exe$/i.test(f) && !/^uninstall/i.test(f)) : undefined;
    if (!exe) throw new Error(`no Kanban95 executable next to ${root}`);
    await boards.start(join(dir, exe), [repo]);
  }
  return { name: basename(repo) };
}

/** Running: bring its window to the front. The window is titled `<folder name> — Kanban95` (shell/src/main.rs title()). */
export async function focusProject(path: unknown): Promise<{ name: string; focused: boolean }> {
  const repo = listed(path);
  const name = basename(repo);
  if (!running().some((e) => same(e.repo, repo))) throw new Error(`${name} is not running`);
  // ponytail: macOS has no way in here; the operator switches from the Dock. An `osascript` activate would be the upgrade.
  if (process.platform !== 'win32') return { name, focused: false };
  // ponytail: the daemon has no IPC to the other shell, so this finds the top-level window by its exact title. Two
  // projects with the same folder name share a title and the first found wins; the registry could record the shell's pid.
  const ok = await powershell(FOCUS_PS, { K95_TITLE: `${name} — Kanban95` });
  return { name, focused: ok };
}

/**
 * SwitchToThisWindow, as Alt+Tab does: it restores a minimized window and is not held back by the foreground lock, which
 * makes SetForegroundWindow and WScript.Shell's AppActivate (it reports success) only flash the taskbar button when this
 * PowerShell did not get the last input, which it never does. Checked on Windows 11 with another app in front.
 * [NullString]: PowerShell passes $null to a string parameter as "", which FindWindow takes as a class name.
 */
const FOCUS_PS = `Add-Type 'using System; using System.Runtime.InteropServices; public static class K95 {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string c, string t);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab); }'
$h = [K95]::FindWindowW([NullString]::Value, $env:K95_TITLE)
if ($h -eq [IntPtr]::Zero) { exit 1 }
[K95]::SwitchToThisWindow($h, $true)`;

const START_PS = `$e = [Environment]::GetEnvironmentVariables(); $e.Remove('K95_CMD')
$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = [string[]]($e.Keys | % { "$_=$($e[$_])" }) }
exit (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:K95_CMD; ProcessStartupInformation = $s }).ReturnValue`;
const powershell = (script: string, env: Record<string, string>) =>
  new Promise<boolean>((ok, fail) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 },
      (e) => (e && typeof e.code !== 'number' ? fail(e) : ok(!e)));
  });

/**
 * The board's own shell runs it in a kill-on-close job (docs/ARCHITECTURE.md → Daemon lifetime) that does not allow
 * breakaway, and libuv's `detached` does not ask for it, so a child spawned here would die when this board closes. On
 * Windows the process is created through WMI instead, which starts it outside the job, with this daemon's environment
 * (KANBAN95_HOME included, so both boards share one registry) and hidden: the dev shell is a console program, and its
 * console stays hidden while its window shows (checked on Windows 11). The command line goes through the environment, so
 * nothing from projects.json is parsed as PowerShell; Windows paths cannot hold a `"`.
 */
async function startDetached(cmd: string, args: string[]): Promise<void> {
  if (process.platform === 'win32') {
    const line = [cmd, ...args].map((a) => `"${a}"`).join(' ');
    if (!(await powershell(START_PS, { K95_CMD: line }))) throw new Error(`could not start ${basename(cmd)}`);
    return;
  }
  await new Promise<void>((ok, fail) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.once('error', fail).once('spawn', () => {
      child.unref();
      ok();
    });
  });
}
