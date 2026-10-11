// Ending a session ends everything its agent started: DELETE /api/sessions/:id, the daemon's close, its stdin closing,
// and a worktree_setup that overruns its timeout each leave no grandchild behind (killTree in launcher.ts).
import './home.ts';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath } from '../src/git.ts';
import { prepareWorktree, sessions, type Session } from '../src/launcher.ts';
import { start } from '../src/server.ts';

// The grandchild writes its pid to grand.pid in its cwd and sleeps. On Windows it is detached, so it has no console:
// node-pty's own kill ends only the processes attached to the pty's console, and a console-less grandchild (headless Edge,
// a detached worker) is what used to survive.
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const GRAND = `
import { writeFileSync } from 'node:fs';
writeFileSync('grand.pid', String(process.pid));
setInterval(() => {}, 1000);
`;
const SPAWNER = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
writeFileSync('fake.pid', String(process.pid));
if (process.argv.includes('quiet')) await new Promise(() => setInterval(() => {}, 1000)); // up, but never prints
console.log('FAKE UP');
spawn(process.execPath, [${JSON.stringify(join(bin, 'grand.mjs'))}], { detached: process.platform === 'win32', stdio: 'ignore' });
setInterval(() => {}, 1000);
`;
const PATH0 = process.env.PATH;
const ROOT = resolve(import.meta.dirname, '../..');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (what: string, f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const pidIn = (dir: string, name: string) => Number(readFileSync(join(dir, name), 'utf8'));
/** The grandchild's pid, once the fake is up (printed first, so killing it cannot crash node-pty) and the grandchild has written it. */
async function grandchild(s: Session) {
  await waitFor('the fake agent', () => s.scrollback().includes('FAKE UP'));
  await waitFor('the grandchild', () => existsSync(join(s.cwd, 'grand.pid')));
  return pidIn(s.cwd, 'grand.pid');
}

let repo: string;
const temps: string[] = [];
beforeAll(() => {
  writeFileSync(join(bin, 'grand.mjs'), GRAND);
  writeFileSync(join(bin, 'spawner.mjs'), SPAWNER);
  writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0spawner.mjs" %*\r\n`);
  process.env.PATH = bin + delimiter + PATH0;
});
afterAll(() => {
  process.env.PATH = PATH0;
  for (const d of [...temps, bin]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  temps.push(repo);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
});

describe('ending a session kills its process tree', { timeout: 30_000 }, () => {
  it('DELETE /api/sessions/:id leaves no grandchild', async () => {
    const srv = await start({ repo });
    try {
      srv.db.prepare("INSERT INTO tickets (id, title) VALUES (7, 'Fix the thing')").run();
      const s = srv.launch({ ticketId: 7, template: 'execute', cli: 'claude', model: 'hang', effort: 'high' });
      const pid = await grandchild(s);
      expect(alive(pid)).toBe(true);
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/sessions/${s.key}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
      expect(r.status).toBe(204);
      await waitFor('the grandchild to die', () => !alive(pid));
      await s.done;
    } finally {
      await srv.close();
    }
  });

  // The race (killSession in launcher.ts): cmd.exe, slow to start under load, creates the CLI after taskkill's snapshot of the
  // tree. A kill in the first ~150 ms meets it in about one in fifty under a loaded run, rarely on an idle machine, so this test
  // fails for it only now and then. The fake writes fake.pid as it starts and never prints.
  it('sessions killed while their CLI is starting, before any output, leave no CLI running', { timeout: 60_000 }, async () => {
    const srv = await start({ repo });
    try {
      const all: Session[] = [];
      for (let id = 1; id <= 4; id++) {
        srv.db.prepare("INSERT INTO tickets (id, title) VALUES (?, 'Fix the thing')").run(id);
        const s = srv.launch({ ticketId: id, template: 'execute', cli: 'claude', model: 'quiet', effort: 'high' });
        all.push(s);
        await new Promise((r) => setTimeout(r, (id - 1) * 40));
        await fetch(`http://127.0.0.1:${srv.port}/api/sessions/${s.key}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
      }
      await Promise.all(all.map((s) => s.done));
      for (const s of all) expect(s.scrollback()).not.toContain('FAKE UP');
      // A fake killed before node ran never wrote its pid. One that did dies within a few seconds of its pty's exit.
      const pids = all.map((s) => join(s.cwd, 'fake.pid')).filter((f) => existsSync(f)).map((f) => Number(readFileSync(f, 'utf8')));
      await waitFor(`fakes ${pids} to die`, () => !pids.some(alive));
    } finally {
      await srv.close();
    }
  });

  it("the daemon's close (killAll) leaves no grandchild", async () => {
    const srv = await start({ repo });
    srv.db.prepare("INSERT INTO tickets (id, title) VALUES (7, 'Fix the thing')").run();
    const s = srv.launch({ ticketId: 7, template: 'execute', cli: 'claude', model: 'hang', effort: 'high' });
    const pid = await grandchild(s);
    await srv.close();
    expect(sessions.size).toBe(0);
    await waitFor('the grandchild to die', () => !alive(pid));
  });

  it('a worktree_setup that overruns its timeout leaves no grandchild', async () => {
    const setup = prepareWorktree(repo, 3, `node "${join(bin, 'spawner.mjs')}"`, 1500)!;
    await expect(setup).rejects.toThrow(/timed out after 1\.5 s/);
    const wt = worktreePath(repo, 3);
    const pid = pidIn(wt, 'grand.pid');
    await waitFor('the grandchild to die', () => !alive(pid));
    expect(alive(pidIn(wt, 'fake.pid'))).toBe(false);
  });

  it("the daemon's stdin closing kills every session's tree before it exits", async () => {
    mkdirSync(process.env.KANBAN95_HOME!, { recursive: true });
    writeFileSync(join(process.env.KANBAN95_HOME!, 'models.json'), JSON.stringify({ cli: 'claude', claude: { plan: { model: 'hang', effort: 'low' } } }));
    const secret = 'c'.repeat(64);
    const { KANBAN95_SHELL: _, ...env } = process.env;
    const child = spawn(process.execPath, [join(ROOT, 'daemon/dist/server.js'), repo], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...env, KANBAN95_SECRET: secret } });
    const exited = once(child, 'exit');
    const [chunk] = await once(child.stdout, 'data');
    const port = Number(/port=(\d+)/.exec(String(chunk))![1]);
    const r = await fetch(`http://127.0.0.1:${port}/api/brainstorm`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `k95=${secret}` }, body: '{}' });
    expect(r.status).toBe(201);
    // The fake prints before it spawns the grandchild, so once grand.pid exists the pty can be killed safely.
    await waitFor('the grandchild', () => existsSync(join(repo, 'grand.pid')));
    const fake = pidIn(repo, 'fake.pid');
    const grand = pidIn(repo, 'grand.pid');
    child.stdin.end();
    const [code] = await exited;
    expect(code).toBe(0);
    await waitFor('the agent tree to die', () => !alive(fake) && !alive(grand));
  });
});
