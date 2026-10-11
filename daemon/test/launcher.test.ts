import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createWorktree, removeWorktree, worktreePath, worktreesRoot } from '../src/git.ts';
import { sessions, type Cli, type Session } from '../src/launcher.ts';
import { start } from '../src/server.ts';

// Fake `claude` and `codex` first on PATH. Each records its argv, env and cwd in the worktree, echoes typed input,
// and behaves by model: `exit3` exits 3 at once, anything else stays up until killed.
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const FAKE = `
import { writeFileSync } from 'node:fs';
writeFileSync('fake-out.json', JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid }));
console.log('FAKE UP');
const model = process.argv[process.argv.indexOf('--model') + 1];
if (model === 'exit3') process.exit(3);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => process.stdout.write('got:' + d.trim() + '\\n'));
`;
const PATH0 = process.env.PATH;

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let db: DatabaseSync;
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
const fakeOut = (s: Session) => JSON.parse(readFileSync(join(worktreePath(repo, s.ticketId), 'fake-out.json'), 'utf8'));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (f: () => boolean, ms = 20_000) => { // a fake's first output took over 5 s in a loaded full run
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const grantRow = (id: number) => db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as { revoked_at: string | null; role: string; ticket_id: number };
const runRow = (id: number) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as { ended_at: string | null; scrollback: string | null; prompt_rendered: string; session_id: string | null };

beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), FAKE);
  for (const cli of ['claude', 'codex']) writeFileSync(join(bin, `${cli}.cmd`), `@node "%~dp0fake.mjs" %*\r\n`);
  process.env.PATH = bin + delimiter + PATH0;
  process.env.KANBAN95_CANARY = 'leaked';
});
afterAll(() => {
  process.env.PATH = PATH0;
  delete process.env.KANBAN95_CANARY;
  rmSync(bin, { recursive: true, force: true });
});

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  srv = await start({ repo });
  db = srv.db;
  db.prepare("INSERT INTO tickets (id, title, body, criteria) VALUES (7, 'Fix the thing', 'body', 'it works')").run();
});
afterEach(async () => {
  // A pty killed before its fake printed leaves the fake running, orphaned (board.ts): close() kills them all.
  await waitFor(() => [...sessions.values()].every((s) => s.scrollback().includes('FAKE UP')));
  await srv.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); // a killed agent can hold it for seconds under load
});

const launch = (cli: Cli, model = 'hang') => srv.launch({ ticketId: 7, template: 'execute', cli, model, effort: 'high' });
// Killing a pty before its process is up crashed the vitest worker with heap corruption (0xC0000374) inside node-pty.
const end = async (s: Session) => {
  await waitFor(() => s.scrollback().includes('FAKE UP'));
  s.pty.kill();
  await s.done;
};

describe('Claude Code pre-trust', () => {
  const state = () => join(process.env.USERPROFILE!, '.claude.json');
  const trustRows = () => db.prepare("SELECT ticket_id, args_summary FROM audit WHERE tool = 'trust.write'").all() as { ticket_id: number; args_summary: string }[];

  it('trusts the repo\'s worktrees root once, merged into the existing file, backed up first and audited', async () => {
    const before = { numStartups: 7, projects: { 'D:/other': { hasTrustDialogAccepted: true, allowedTools: ['x'] } } };
    writeFileSync(state(), JSON.stringify(before));
    const s = launch('claude');
    const key = worktreesRoot(repo).replaceAll('\\', '/');
    expect(key.startsWith(process.env.KANBAN95_HOME!.replaceAll('\\', '/') + '/worktrees/')).toBe(true);
    const after = JSON.parse(readFileSync(state(), 'utf8'));
    expect(after).toEqual({ ...before, projects: { ...before.projects, [key]: { hasTrustDialogAccepted: true } } });
    expect(JSON.parse(readFileSync(state() + '.kanban95.bak', 'utf8'))).toEqual(before);
    // args_summary is cut at 200 characters, which a key under the throwaway home outruns.
    expect(trustRows()).toEqual([{ ticket_id: 7, args_summary: expect.stringContaining(`"key":"projects[\\"${key}`.slice(0, 60)) }]);
    await end(s);
    await end(srv.launch({ ticketId: 7, template: 'test', cli: 'claude', model: 'hang', effort: 'low' })); // second launch: no write
    expect(trustRows()).toHaveLength(1);
  });

  it('writes nothing when an ancestor of the worktrees root is already trusted', async () => {
    const parent = process.env.KANBAN95_HOME!.replaceAll('\\', '/');
    writeFileSync(state(), JSON.stringify({ projects: { [parent]: { hasTrustDialogAccepted: true } } }));
    await end(launch('claude'));
    expect(trustRows()).toHaveLength(0);
    expect(JSON.parse(readFileSync(state(), 'utf8')).projects).toEqual({ [parent]: { hasTrustDialogAccepted: true } });
  });

  it('Codex launches write no file at all', async () => {
    rmSync(state(), { force: true });
    await end(launch('codex'));
    expect(existsSync(state())).toBe(false);
    expect(trustRows()).toHaveLength(0);
  });
});

describe('launch', () => {
  it('produces a worktree, a worker grant, a session dir, a run row with the prompt and a live pty', async () => {
    const s = launch('claude');
    await waitFor(() => existsSync(join(worktreePath(repo, 7), 'fake-out.json')));
    expect(git('branch', '--list', 'ticket/7')).toContain('ticket/7');
    expect(grantRow(s.grantId)).toMatchObject({ role: 'worker', ticket_id: 7, revoked_at: null });
    expect(readFileSync(join(s.dir, 'prompt.md'), 'utf8')).toBe(runRow(s.runId).prompt_rendered);
    const cfg = JSON.parse(readFileSync(join(s.dir, 'mcp.json'), 'utf8')).mcpServers.kanban95;
    expect(cfg.url).toBe(`http://127.0.0.1:${srv.port}/mcp`);
    expect(cfg.headers.Authorization).toMatch(/^Bearer [\w-]{43}$/);
    expect(sessions.get(s.runId)?.pty.pid).toBeGreaterThan(0);
    expect(fakeOut(s).argv.at(-1)).toBe(`Read ${join(s.dir, 'prompt.md').replaceAll('\\', '/')} in full and follow it. It is your brief for this session.`);
    const argv = fakeOut(s).argv as string[];
    expect(runRow(s.runId).session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(runRow(s.runId).session_id);
    // The worktree is under the board home, named for the repo's folder and a hash of its path; nothing new is under the repo.
    const wt = fakeOut(s).cwd as string;
    expect(dirname(dirname(wt))).toBe(join(process.env.KANBAN95_HOME!, 'worktrees'));
    expect(basename(dirname(wt))).toMatch(new RegExp(`^${basename(realpathSync.native(repo))}-[0-9a-f]{8}$`));
    expect(basename(wt)).toBe('t-7');
    expect(readdirSync(repo).sort()).toEqual(['.git', '.kanban95', 'a.txt']);
  });

  it('passes only the env allowlist: a canary on the daemon is absent in the child', async () => {
    const s = launch('codex');
    await waitFor(() => existsSync(join(worktreePath(repo, 7), 'fake-out.json')));
    const env = fakeOut(s).env as Record<string, string>;
    const keys = Object.keys(env).map((k) => k.toUpperCase());
    expect(keys).not.toContain('KANBAN95_CANARY');
    expect(keys).toContain('PATH');
    // The daemon's own Node first: PATH's `node` may be older than 24.
    expect(env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH')!].split(delimiter)[0]).toBe(dirname(process.execPath));
    expect(env.KANBAN95_TOKEN).toMatch(/^[\w-]{43}$/); // codex reads its bearer token from here
    expect(env.KANBAN95_AGENT).toBe('1'); // makes npm run dev and Kanban95.cmd refuse to start
    expect(existsSync(join(s.dir, 'mcp.json'))).toBe(false); // codex gets its MCP server through -c, not a file
    expect(runRow(s.runId!).session_id).toBeNull();
  });

  it('revoking the grant over REST kills the pty, removes the session dir and stores the scrollback within a second', async () => {
    const s = launch('claude');
    await waitFor(() => s.scrollback().includes('FAKE UP'));
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/grants/${s.grantId}`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    expect(r.status).toBe(204);
    await s.done;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(existsSync(s.dir)).toBe(false);
    expect(sessions.has(s.runId)).toBe(false);
    expect(grantRow(s.grantId).revoked_at).not.toBeNull();
    expect(runRow(s.runId).ended_at).not.toBeNull();
    expect(runRow(s.runId).scrollback).toContain('FAKE UP');
    await waitFor(() => !alive(fakeOut(s).pid), 1000 - (Date.now() - t0)); // the CLI itself, not just cmd.exe
    expect(existsSync(worktreePath(repo, 7))).toBe(true); // the operator decides about the worktree
  });

  it('deleting the ticket ends its session within a second: grant gone, pty killed, session map cleared', async () => {
    const s = launch('claude');
    await waitFor(() => s.scrollback().includes('FAKE UP'));
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/tickets/7`, { method: 'DELETE', headers: { cookie: `k95=${srv.secret}` } });
    expect(r.status).toBe(204);
    await s.done;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(sessions.has(s.runId)).toBe(false);
    expect(grantRow(s.grantId)).toBeUndefined(); // revoked, then cascaded away with the ticket
    expect(existsSync(s.dir)).toBe(false);
    await waitFor(() => !alive(fakeOut(s).pid), 1000 - (Date.now() - t0));
  });

  it('an agent that dies on its own (exit 3) still revokes the grant and removes the session dir', async () => {
    const s = launch('claude', 'exit3');
    await s.done;
    expect(existsSync(s.dir)).toBe(false);
    expect(grantRow(s.grantId).revoked_at).not.toBeNull();
    expect(runRow(s.runId).scrollback).toContain('FAKE UP');
  });

  it('killing the pty directly tears down the same way', async () => {
    const s = launch('codex');
    await waitFor(() => s.scrollback().includes('FAKE UP'));
    s.pty.kill();
    await s.done;
    expect(existsSync(s.dir)).toBe(false);
    expect(grantRow(s.grantId).revoked_at).not.toBeNull();
  });

  it('a bad template fails before anything is spawned and leaves no grant', () => {
    writeFileSync(join(repo, '.kanban95', 'templates', 'execute.md'), '{{nope}}');
    expect(() => launch('claude')).toThrow('unknown variable {{nope}}');
    expect(db.prepare('SELECT count(*) AS n FROM grants').get()).toEqual({ n: 0 });
  });
});

describe('websocket /pty/<run-id>', () => {
  const connect = (path: string, origin?: string, secret = srv.secret) =>
    new WebSocket(`ws://127.0.0.1:${srv.port}${path}`, { ...(origin ? { origin } : {}), headers: { cookie: `k95=${secret}` } });
  const refused = (ws: WebSocket) => new Promise<number | undefined>((ok) => {
    ws.on('unexpected-response', (_req, res) => ok(res.statusCode));
    ws.on('open', () => ok(undefined));
    ws.on('error', () => {});
  });

  it('refuses a missing or foreign origin, an unknown run and a wrong secret', async () => {
    const s = launch('claude');
    expect(await refused(connect(`/pty/${s.runId}`))).toBe(403);
    expect(await refused(connect(`/pty/${s.runId}`, 'http://evil.test'))).toBe(403);
    expect(await refused(connect('/pty/999', `http://127.0.0.1:${srv.port}`))).toBe(403);
    expect(await refused(connect(`/pty/${s.runId}`, `http://127.0.0.1:${srv.port}`, 'stale'))).toBe(401);
  });

  it('streams scrollback and output out, typed input in, and closes when the pty exits', async () => {
    const s = launch('claude');
    await waitFor(() => s.scrollback().includes('FAKE UP'));
    const ws = connect(`/pty/${s.runId}`, `http://127.0.0.1:${srv.port}`);
    let seen = '';
    ws.on('message', (m) => (seen += String(m)));
    await new Promise((r) => ws.on('open', r));
    await waitFor(() => seen.includes('FAKE UP'));
    ws.send(JSON.stringify({ resize: [100, 40] }));
    ws.send(JSON.stringify({ data: 'ping\r' }));
    await waitFor(() => seen.includes('got:ping'));
    const closed = new Promise((r) => ws.on('close', r));
    s.pty.kill();
    await closed;
  });
});

describe('git worktrees', () => {
  it('gives two repos with the same folder name different worktree roots, and one repo one root however it is spelled', () => {
    const a = join(repo, 'a', 'proj');
    const b = join(repo, 'b', 'proj');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    expect(dirname(worktreesRoot(a))).toBe(dirname(worktreesRoot(b)));
    expect(basename(worktreesRoot(a))).toMatch(/^proj-[0-9a-f]{8}$/);
    expect(worktreesRoot(a)).not.toBe(worktreesRoot(b));
    expect(worktreesRoot(join(a, '..', 'proj'))).toBe(worktreesRoot(a));
    if (process.platform === 'win32') expect(worktreesRoot(a.toUpperCase())).toBe(worktreesRoot(a));
  });

  it('refuses to fork from a base branch with uncommitted changes, and says so', () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    expect(() => createWorktree(repo, 7)).toThrow(/base branch main has uncommitted changes/);
    expect(existsSync(worktreePath(repo, 7))).toBe(false);
  });

  it('ignores untracked files and reuses an existing worktree', () => {
    writeFileSync(join(repo, 'new.txt'), 'x');
    const a = createWorktree(repo, 7);
    expect(a).toMatchObject({ branch: 'ticket/7', base: 'main' });
    expect(createWorktree(repo, 7)).toEqual(a);
  });

  it('remove deletes a merged branch and keeps an unmerged one', () => {
    createWorktree(repo, 7);
    expect(removeWorktree(repo, 7)).toEqual({ branchDeleted: true });
    const wt = createWorktree(repo, 8).path;
    writeFileSync(join(wt, 'b.txt'), 'b');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'b.txt'], { cwd: wt });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b'], { cwd: wt });
    expect(removeWorktree(repo, 8)).toEqual({ branchDeleted: false });
    expect(existsSync(wt)).toBe(false);
    expect(git('branch', '--list', 'ticket/8')).toContain('ticket/8');
  });
});
