import './home.ts';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { brainstorm, changed } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';
import { globalPath, writeConfig } from '../src/settings.ts';
import { removeTemp } from './home.ts';
import { fakeCli } from './fake-cli.ts';

const FAST = 0.01;
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const PATH0 = process.env.PATH;
const dirs: string[] = [bin];
const lines: string[] = [];
const closes = () => lines.filter((l) => l.startsWith('KANBAN95 close='));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(25);
  }
};

let repo: string;
let srv: Awaited<ReturnType<typeof start>> | undefined;
const boot = async (shell: boolean, sleepAfterMinutes: number) => {
  writeConfig('settings', { sleepAfterMinutes }, repo);
  srv = await start({ repo, shell });
  return srv;
};

beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), "console.log('FAKE UP'); setInterval(() => {}, 1000);\n");
  fakeCli(bin, 'claude', 'fake.mjs');
  process.env.PATH = bin + delimiter + PATH0;
  mkdirSync(process.env.KANBAN95_HOME!, { recursive: true });
  writeFileSync(globalPath('models'), JSON.stringify({ cli: 'claude', claude: { plan: { model: 'm' } } }));
});
afterAll(() => {
  process.env.PATH = PATH0;
  for (const d of dirs) removeTemp(d);
});
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-sleep-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  dirs.push(repo);
  lines.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (lines.push(String(chunk)), true));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await srv?.close();
  srv = undefined;
});

describe('board sleep', { timeout: 30_000 }, () => {
  it('a shell board with no session and no /events client writes close=<repo> once, only after the idle period', async () => {
    await boot(true, FAST);
    await wait(200);
    expect(closes()).toEqual([]);
    await until(() => closes().length > 0);
    await wait(1500);
    expect(closes()).toEqual([`KANBAN95 close=${repo}\n`]);
  });

  it('a project copy of sleepAfterMinutes overrides the global value', async () => {
    writeConfig('settings', { sleepAfterMinutes: 0 });
    try {
      await boot(true, FAST);
      await until(() => closes().length > 0);
    } finally {
      writeConfig('settings', {});
    }
  });

  it('a connected /events client keeps the board awake; it sleeps once the client leaves', async () => {
    const { port, secret } = await boot(true, 0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, { origin: `http://127.0.0.1:${port}`, headers: { cookie: `k95=${secret}` } });
    await once(ws, 'open');
    writeConfig('settings', { sleepAfterMinutes: FAST }, repo);
    changed(null);
    await wait(1500);
    expect(closes()).toEqual([]);
    ws.close();
    await until(() => closes().length > 0);
  });

  it('a live session keeps the board awake; it sleeps once the session ends', async () => {
    const { board } = await boot(true, 0);
    const s = brainstorm(board);
    writeConfig('settings', { sleepAfterMinutes: FAST }, repo);
    await until(() => s.scrollback().includes('FAKE UP'));
    await wait(1500);
    expect(closes()).toEqual([]);
    s.pty.kill();
    await s.done;
    await until(() => closes().length > 0);
  });

  it('with sleepAfterMinutes 0 the board never writes close', async () => {
    await boot(true, 0);
    changed(null);
    await wait(1500);
    expect(closes()).toEqual([]);
  });

  it('a board not started by the shell never writes close', async () => {
    await boot(false, FAST);
    changed(null);
    await wait(1500);
    expect(closes()).toEqual([]);
  });
});
