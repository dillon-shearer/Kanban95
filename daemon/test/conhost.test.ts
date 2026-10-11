// Windows: every pty runs under its own conhost.exe, a child of the daemon. When a session ends, by itself or by the board,
// that conhost goes too (spawnPty in pty.ts), so a long-running daemon does not collect one per session it ever ran.
import './home.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Session } from '../src/launcher.ts';
import { start } from '../src/server.ts';

const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
// `exit0` exits by itself once up; anything else stays up until killed.
const FAKE = `
console.log('FAKE UP');
const model = process.argv[process.argv.indexOf('--model') + 1];
if (model === 'exit0') setTimeout(() => process.exit(0), 200);
else setInterval(() => {}, 1000);
`;
const PATH0 = process.env.PATH;

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;

/** The pids of the conhost.exe processes whose parent is this process, which is the daemon here. */
const conhosts = () => new Set(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='conhost.exe'" | ForEach-Object { $_.ProcessId }`],
{ encoding: 'utf8', windowsHide: true }).split(/\s+/).filter(Boolean).map(Number));
const waitFor = async (what: string, f: () => boolean, ms = 20_000) => { // a fake's first output took over 5 s in a loaded full run
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
/** Launches a session and returns it with the conhost pids that appeared for it. */
async function launch(model: string) {
  const before = conhosts();
  const s: Session = srv.launch({ ticketId: 7, template: 'execute', cli: 'claude', model, effort: 'high' });
  await waitFor('the fake agent', () => s.scrollback().includes('FAKE UP'));
  const mine = [...conhosts()].filter((p) => !before.has(p));
  expect(mine.length).toBeGreaterThan(0);
  return { s, mine };
}
/** Polls (each listing takes about a second) until none of `pids` is still a child conhost, or fails after ~5 s. */
async function expectGone(pids: number[]) {
  const end = Date.now() + 5000;
  let left = pids;
  while ((left = pids.filter((p) => conhosts().has(p))).length && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  expect(left).toEqual([]);
}

beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), FAKE);
  writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
  process.env.PATH = bin + delimiter + PATH0;
});
afterAll(() => {
  process.env.PATH = PATH0;
  rmSync(bin, { recursive: true, force: true, maxRetries: 5 });
});
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  srv = await start({ repo });
  srv.db.prepare("INSERT INTO tickets (id, title) VALUES (7, 'Fix the thing')").run();
});
afterEach(async () => {
  await srv.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
});

describe.skipIf(process.platform !== 'win32')("a session's conhost.exe closes when the session ends", { timeout: 60_000 }, () => {
  it('when the agent exits by itself', async () => {
    const { s, mine } = await launch('exit0');
    await s.done;
    await expectGone(mine);
  });

  it('when the board kills it (DELETE /api/sessions/:id)', async () => {
    const { s, mine } = await launch('hang');
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/sessions/${s.key}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    expect(r.status).toBe(204);
    await s.done;
    await expectGone(mine);
  });
});
