import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mark, MEMLOG_KEEP, sample, sources, startMemoryLog, trim, type Live, type Proc } from '../src/memlog.ts';
import { removeTemp } from './home.ts';

const MB = 1024 * 1024;
const real = { ...sources };
let repo: string;
let stop: () => void;
const log = () => readFileSync(join(repo, '.kanban95', 'memory.log'), 'utf8').split('\n').filter(Boolean);
const proc = (pid: number, ppid: number, mb: number, name = 'node.exe'): Proc => ({ pid, ppid, ws: mb * MB, name });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-memlog-'));
  mkdirSync(join(repo, '.kanban95'));
});
afterEach(() => {
  stop?.();
  Object.assign(sources, real);
  removeTemp(repo);
});

describe('memory log', () => {
  it("writes free and total memory, commit charge, and each live session's process tree summed", async () => {
    const live: Live[] = [{ key: 10, ticketId: 121, pty: { pid: 100 } }, { key: -4, ticketId: null, pty: { pid: 200 } }, { key: 11, ticketId: 122, pty: { pid: 300 } }];
    stop = startMemoryLog(repo, () => live);
    sources.free = () => 1500 * MB;
    sources.total = () => 32000 * MB;
    sources.rss = () => 150 * MB;
    sources.snapshot = async () => ({
      commit: { used: 40000 * MB, limit: 50000 * MB },
      procs: [
        proc(100, 1, 5, 'cmd.exe'),
        proc(101, 100, 400, 'claude.exe'),
        proc(102, 101, 900, 'msedge.exe'),
        proc(103, 102, 600, 'msedge.exe'),
        proc(104, 100, 10, 'conhost.exe'),
        proc(105, 104, 105, 'node.exe'),
        proc(106, 106, 50, 'msedge.exe'),
        proc(200, 1, 20, 'cmd.exe'),
        proc(201, 200, 30, 'codex.exe'),
        proc(999, 1, 3000, 'vmmem'),
      ],
    });
    await sample();
    const [line] = log();
    const [stamp, tag, ...fields] = line.split(' ');
    expect(Date.now() - Date.parse(stamp)).toBeLessThan(5000);
    expect(tag).toBe('mem');
    expect(fields).toEqual([
      'free=1500MB', 'total=32000MB', 'commit=40000MB/50000MB', 'daemon=150MB', 'procs=10',
      't121=2020MB/6', 's-4=50MB/2', 't122=0MB/0',
      'top=vmmem:3000MB/1,msedge.exe:1550MB/3,claude.exe:400MB/1',
    ]);
  });

  it('still writes free and total memory when the process listing fails', async () => {
    stop = startMemoryLog(repo, () => [{ key: 1, ticketId: 5, pty: { pid: 1 } }]);
    sources.free = () => 2048 * MB;
    sources.total = () => 4096 * MB;
    sources.snapshot = async () => { throw new Error('powershell timed out\nmore'); };
    await sample();
    expect(log()[0]).toMatch(/ mem free=2048MB total=4096MB snapshot-error="powershell timed out" daemon=\d+MB$/);
  });

  it('tags launches, kills and merges with the ticket, and writes nothing once stopped', () => {
    stop = startMemoryLog(repo, () => []);
    mark('launch', 't130', 'execute');
    mark('kill', 't130', 'execute');
    mark('merge-start', 't130');
    mark('merge-end', 't130', 'ok');
    stop();
    mark('launch', 't131', 'execute');
    expect(log().map((l) => l.split(' ').slice(1).join(' '))).toEqual(['launch t130 execute', 'kill t130 execute', 'merge-start t130', 'merge-end t130 ok']);
  });

  it('trims lines older than a day and keeps the rest', () => {
    stop = startMemoryLog(repo, () => []);
    const now = Date.now();
    const at = (ms: number) => new Date(now - ms).toISOString();
    writeFileSync(join(repo, '.kanban95', 'memory.log'), [
      `${at(MEMLOG_KEEP + 1)} mem free=1MB`,
      `${at(MEMLOG_KEEP)} mem free=2MB`,
      `${at(1000)} launch t1 execute`,
    ].join('\n') + '\n');
    trim(now);
    expect(log()).toEqual([`${at(MEMLOG_KEEP)} mem free=2MB`, `${at(1000)} launch t1 execute`]);
  });
});
