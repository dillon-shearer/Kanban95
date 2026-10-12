import './home.ts';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { entryPath, focusProject } from '../src/boards.ts';
import { openDb } from '../src/db.ts';
import { sweep } from '../src/janitor.ts';
import { killSession, type Session } from '../src/launcher.ts';
import { sources } from '../src/memlog.ts';
import { writeProjects } from '../src/settings.ts';
import { removeTemp } from './home.ts';

const out = vi.hoisted(() => ({ ps: '' }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const execFile = (_cmd: string, ...rest: unknown[]) => {
    const cb = rest.findLast((a) => typeof a === 'function') as ((e: Error | null, out: string, err: string) => void) | undefined;
    setImmediate(() => cb?.(null, out.ps, ''));
    return {};
  };
  return { ...real, execFile: vi.fn(execFile), execFileSync: vi.fn(real.execFileSync), spawn: vi.fn(real.spawn), spawnSync: vi.fn(real.spawnSync) };
});
const commands = () => [execFile, execFileSync, spawn, spawnSync].flatMap((f) => vi.mocked(f).mock.calls.map((c) => String(c[0])));
const powershell = () => commands().filter((c) => /powershell/i.test(c));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let repo: string;
let db: DatabaseSync;
beforeAll(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'k95-darwin-')));
  db = openDb(repo);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
});
afterEach(() => {
  vi.mocked(execFile).mockClear();
  vi.mocked(execFileSync).mockClear();
  vi.mocked(spawn).mockClear();
  vi.mocked(spawnSync).mockClear();
  vi.restoreAllMocks();
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
  db.close();
  removeTemp(repo);
});

it('the process sweep lists processes with ps and kills an orphan by its process group', async () => {
  const dir = `${join(repo, '.kanban95', 'sessions')}/7002/prompt.md`;
  out.ps = `    1     0 /sbin/launchd\n 4242     1 claude --append-system-prompt-file ${dir}\n`;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  await sweep({ db, repo });
  await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL'));
  expect(vi.mocked(execFile).mock.calls.map((c) => [c[0], c[1]])).toEqual([['ps', ['-eo', 'pid=,ppid=,args=']]]);
  expect(powershell()).toEqual([]);
});

it('the memory snapshot reads ps, with resident size in KB', async () => {
  out.ps = '    1     0  2048 /sbin/launchd\n  501     1   512 node\n';
  const snap = await sources.snapshot();
  expect(snap.procs).toEqual([{ pid: 1, ppid: 0, ws: 2048 * 1024, name: '/sbin/launchd' }, { pid: 501, ppid: 1, ws: 512 * 1024, name: 'node' }]);
  expect(vi.mocked(execFile).mock.calls.map((c) => c[0])).toEqual(['ps']);
  expect(powershell()).toEqual([]);
});

it('focusing another running board answers focused: false and starts nothing', async () => {
  const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'k95-darwin-other-')));
  try {
    writeProjects([{ path: repo, colour: 120 }, { path: other, colour: 200 }], repo);
    mkdirSync(join(process.env.KANBAN95_HOME!, 'running'), { recursive: true });
    writeFileSync(entryPath(process.pid), JSON.stringify({ pid: process.pid, repo: other, port: 1, started: new Date().toISOString() }));
    expect(await focusProject(other)).toEqual({ name: other.split(/[\\/]/).pop(), focused: false });
    expect(commands()).toEqual([]);
  } finally {
    rmSync(entryPath(process.pid), { force: true });
    removeTemp(other);
  }
});

it('ending a session before its CLI printed kills the group and reaps no orphans', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const pty = { pid: 4343, kill: vi.fn(), onExit: vi.fn() };
  const s = { key: 1, ticketId: 1, phase: 'execute', pty, started: Date.now(), scrollback: () => '' } as unknown as Session;
  killSession(s);
  expect(kill).toHaveBeenCalledWith(-4343, 'SIGKILL');
  expect(pty.kill).toHaveBeenCalled();
  expect(s.reaped).toBeUndefined();
  expect(commands()).toEqual([]);
});
