// A board started on a plain folder makes it a local repo with one commit (docs/ARCHITECTURE.md → Daemon lifetime → First start
// on a plain folder), and runs tickets there; with no git identity it still serves and says why nothing can launch.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readTicket } from '../src/api.ts';
import { FIRST_COMMIT } from '../src/git.ts';
import { sessionsOf } from '../src/launcher.ts';
import { start } from '../src/server.ts';

// Commits a file holding its own working directory, then submits; a test run passes.
const FAKE = `
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const argv = process.argv.slice(2);
const mcp = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.kanban95;
const brief = readFileSync(/^Read (\\S+) in full/.exec(argv.at(-1))[1], 'utf8');
const call = (name, args = {}) => fetch(mcp.url, {
  method: 'POST',
  headers: { ...mcp.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
}).then((r) => r.json());
console.log('FAKE'); // ConPTY may not end a kill on a console that has printed nothing yet
if (brief.startsWith('# Test')) {
  await call('report_test', { passed: true, summary: 'ok' });
} else {
  const file = basename(process.cwd()) + '.txt';
  writeFileSync(file, process.cwd());
  execFileSync('git', ['add', file]);
  execFileSync('git', ['commit', '-qm', 'Add ' + file]);
  await call('move_ticket', { status: 'testing' });
}
process.stdin.resume();
`;
const home = process.env.USERPROFILE!;
const gitconfig = join(home, '.gitconfig');
const IDENTITY = '[user]\n\tname = Op Erator\n\temail = op@example.com\n';
// Nothing but the throwaway home's .gitconfig may give git an identity.
const CLEARED = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_GLOBAL'];
const saved = Object.fromEntries(['PATH', 'GIT_CONFIG_NOSYSTEM', ...CLEARED].map((k) => [k, process.env[k]]));
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
beforeAll(() => {
  for (const k of CLEARED) delete process.env[k];
  writeFileSync(join(bin, 'fake.mjs'), FAKE);
  writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
  process.env.PATH = bin + delimiter + saved.PATH;
  mkdirSync(join(home, '.kanban95'), { recursive: true });
  writeFileSync(join(home, '.kanban95', 'models.json'), JSON.stringify({
    cli: 'claude', claude: { execute: { model: 'work', effort: 'low' }, test: { model: 'pass', effort: 'low' } },
  }));
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(bin, { recursive: true, force: true });
});

let dir: string;
let srv: Awaited<ReturnType<typeof start>> | undefined;
const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const commits = () => Number(git('rev-list', '--count', 'HEAD'));
const files = () => git('ls-files').split('\n');
const request = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${srv!.port}${path}`, {
  method, headers: { 'content-type': 'application/json', cookie: `k95=${srv!.secret}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
const ticket = (title: string) => Number(srv!.db.prepare('INSERT INTO tickets (title) VALUES (?)').run(title).lastInsertRowid);
const until = async (f: () => unknown, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const restart = async () => {
  await srv?.close();
  srv = await start({ repo: dir });
};

beforeEach(() => {
  writeFileSync(gitconfig, IDENTITY);
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'k95-plain-')));
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); // a killed agent can hold it for seconds under load
});

describe('git init', { timeout: 60_000 }, () => {
  it('an empty folder becomes a repo with one commit by the operator; a second start adds none', async () => {
    await restart();
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8').split('\n')).toEqual(expect.arrayContaining(['node_modules/', 'dist/', 'build/', '.worktrees/', '.kanban95/board.db']));
    expect(commits()).toBe(1);
    expect(git('log', '-1', '--format=%an <%ae>%n%B')).toBe(`Op Erator <op@example.com>\n${FIRST_COMMIT}`); // no trailer
    expect(files()).toEqual(expect.arrayContaining(['.gitignore', '.kanban95/.gitignore']));
    expect(files()).not.toContain('.kanban95/board.db');
    expect(await (await request('GET', '/api/runner')).json()).not.toHaveProperty('gitError');

    await restart();
    expect(commits()).toBe(1);
  });

  it('a folder with files: one commit holds them but not node_modules, then tickets run in .worktrees/t-<id> two at a time and merge', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'b.ts'), 'b\n');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), '');
    await restart();
    expect(commits()).toBe(1);
    expect(files()).toEqual(expect.arrayContaining(['.gitignore', 'a.txt', 'src/b.ts']));
    expect(files().filter((f) => f.startsWith('node_modules'))).toEqual([]);
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');

    const ids = [ticket('One'), ticket('Two')];
    expect((await request('PUT', '/api/runner', { concurrency: 2 })).status).toBe(200);
    expect(await (await request('PUT', '/api/runner', { on: true })).json()).toMatchObject({ on: true, running: ids });
    for (const id of ids) {
      await until(() => readTicket(srv!.db, id).merged_at && !sessionsOf(id).length && !existsSync(join(dir, '.worktrees', `t-${id}`)), `ticket ${id} merged`);
      // The agent's working directory, as it wrote it into the file it committed.
      expect(readFileSync(join(dir, `t-${id}.txt`), 'utf8').toLowerCase()).toBe(join(dir, '.worktrees', `t-${id}`).toLowerCase());
    }
    expect(git('log', '--merges', '--format=%s').split('\n')).toEqual(expect.arrayContaining(['One', 'Two']));
  });

  it('a repo with no commit gets the first commit and keeps its own .gitignore', async () => {
    git('init', '-q');
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(dir, 'secret.txt'), 'x');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    await restart();
    expect(commits()).toBe(1);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('secret.txt\n');
    expect(files()).toEqual(expect.arrayContaining(['.gitignore', 'a.txt']));
    expect(files()).not.toContain('secret.txt');
  });

  it('a repo with commits is left as it is', async () => {
    git('init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'mine');
    const head = git('rev-parse', 'HEAD');
    await restart();
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  it('with no git identity the daemon still serves, the runner state says why, and a launch fails with that message', async () => {
    rmSync(gitconfig);
    process.env.GIT_CONFIG_NOSYSTEM = '1'; // an identity in git's system config would be found too
    try {
      await restart();
    } finally {
      if (saved.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = saved.GIT_CONFIG_NOSYSTEM;
    }
    expect((await fetch(`http://127.0.0.1:${srv!.port}/health`)).status).toBe(200);
    const { gitError } = await (await request('GET', '/api/runner')).json();
    expect(gitError).toMatch(/no git repo with a commit.*user\.name or user\.email/);
    expect(() => git('rev-parse', '--verify', 'HEAD')).toThrow();

    const id = ticket('Cannot run');
    expect((await request('POST', `/api/tickets/${id}/launch`)).status).toBe(200);
    expect(readTicket(srv!.db, id).flags.needs_human).toBe(true);
    const note = srv!.db.prepare("SELECT body FROM notes WHERE ticket_id = ? AND kind = 'failure'").get(id) as { body: string };
    expect(note.body.split('\n')[0]).toBe(`launch failed: ${gitError}`);
    expect(existsSync(join(dir, '.worktrees'))).toBe(false);
  });
});
