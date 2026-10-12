// Start -> Release board (docs/LIFECYCLE.md -> Release board): POST /api/release and the release-pending count.
import './home.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bumped, installed, restartBoard } from '../src/lifecycle.ts';
import { removeTemp } from './home.ts';
import { git, landed, models, post, repo, send, srv, ticket } from './board.ts';

const remotes: string[] = [];
const bare = () => {
  const d = mkdtempSync(join(tmpdir(), 'k95-remote-'));
  remotes.push(d);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: d });
  return d;
};
afterAll(() => remotes.forEach(removeTemp));
const version = () => JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;

/** Makes the test repo look like Kanban95's at v0.1.0, pushed to a fresh bare remote. Returns the remote. */
function kanban95() {
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'kanban95', version: '0.1.0', private: true }, null, 2) + '\n');
  mkdirSync(join(repo, 'shell'), { recursive: true });
  writeFileSync(join(repo, 'shell', 'tauri.conf.json'), '{}\n');
  git('add', 'package.json', 'shell/tauri.conf.json');
  git('commit', '-qm', 'Look like Kanban95');
  git('tag', 'v0.1.0');
  const remote = bare();
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main', 'v0.1.0');
  return remote;
}
const release = (bump = 'patch') => post('/api/release', { bump });
const at = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

describe('POST /api/release', { timeout: 60_000 }, () => {
  it('is refused while a ticket runs, naming the count', async () => {
    kanban95();
    const id = ticket('Running', { status: 'in_progress' });
    const r = await release();
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('1 ticket running and 0 terminals open; release once nothing runs');
    expect(version()).toBe('0.1.0');
    srv.db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);
  });

  it('is refused on a dirty main, then on an unpushed main', async () => {
    kanban95();
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    let r = await release();
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/^the main working tree has uncommitted changes:\n *M a\.txt$/);
    git('commit', '-qam', 'Edit a');
    r = await release();
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('main has 1 commit not pushed; push first');
    expect(git('tag')).toBe('v0.1.0');
    expect(srv.db.prepare("SELECT outcome FROM audit WHERE tool = 'board.release'").all()).toEqual([{ outcome: 'error' }, { outcome: 'error' }]);
  });

  it('is refused outside the Kanban95 repo', async () => {
    const r = await release();
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/^only the Kanban95 repo releases/);
  });

  it('bumps, commits as the operator, tags and pushes main and the tag', async () => {
    const remote = kanban95();
    expect(await (await send('GET')('/api/release')).json()).toEqual({ version: '0.1.0', next: { patch: '0.1.1', minor: '0.2.0', major: '1.0.0' } });
    const r = await release('patch');
    expect(r.status).toBe(200);
    expect((await r.json()).tag).toBe('v0.1.1');
    expect(version()).toBe('0.1.1');
    expect(git('log', '-1', '--format=%an <%ae>|%cn|%B')).toBe('Op Erator <op@example.com>|Op Erator|Release v0.1.1');
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(at(remote, 'rev-parse', 'main')).toBe(git('rev-parse', 'HEAD'));
    expect(at(remote, 'rev-parse', 'v0.1.1^{commit}')).toBe(git('rev-parse', 'HEAD'));
    expect(srv.db.prepare("SELECT args_summary AS args, outcome FROM audit WHERE tool = 'board.release'").all()).toEqual([{ args: '{"bump":"patch"}', outcome: 'ok' }]);
  });

  it('takes the commit and tag back when the push fails', async () => {
    kanban95();
    const head = git('rev-parse', 'HEAD');
    git('remote', 'set-url', 'origin', join(tmpdir(), 'k95-no-such-remote'));
    const r = await release('minor');
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/^git push to origin failed:/);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('tag')).toBe('v0.1.0');
    expect(version()).toBe('0.1.0');
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('refuses a bump that is not patch, minor or major', async () => {
    expect((await release('huge')).status).toBe(400);
  });
});

describe('release pending', { timeout: 60_000 }, () => {
  it('counts commits since the last tag after a merge touching daemon/', async () => {
    kanban95();
    srv.board.root = undefined;
    models({ execute: 'touch-daemon' });
    const id = ticket('Touch the daemon');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await landed(id);
    expect(await (await send('GET')('/api/runner')).json()).toMatchObject({ stale: 'daemon', release: { pending: true, since: 'v0.1.0', commits: 1 } });
  });

  it('an installed board shows release pending instead of going stale after a merge', async () => {
    kanban95();
    srv.board.root = repo;
    models({ execute: 'touch-daemon' });
    const id = ticket('Touch the daemon');
    expect((await post(`/api/tickets/${id}/launch`)).status).toBe(200);
    await landed(id);
    const state = await (await send('GET')('/api/runner')).json();
    expect(state).toMatchObject({ stale: false, release: { pending: true, since: 'v0.1.0', commits: 1 } });
    expect(state).not.toHaveProperty('hold');
  });
});

describe('installed or checkout', () => {
  it('a root without daemon/src is installed, and Restart board builds nothing there', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k95-app-'));
    remotes.push(root);
    expect(installed(root)).toBe(true);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "process.exit(3)"' } }));
    let code = 0;
    expect(await restartBoard({ ...srv.board, root, shutdown: (c) => { code = c; } })).toBeNull();
    await new Promise((ok) => setTimeout(ok, 100));
    expect(code).toBe(75);
    mkdirSync(join(root, 'daemon', 'src'), { recursive: true });
    expect(installed(root)).toBe(false);
    expect(await restartBoard({ ...srv.board, root, shutdown: () => {} })).not.toBeNull();
  });

  it('bumps as npm version does', () => {
    expect(['patch', 'minor', 'major'].map((b) => bumped('1.2.3', b as 'patch'))).toEqual(['1.2.4', '1.3.0', '2.0.0']);
    expect(['patch', 'minor', 'major'].map((b) => bumped('0.2.0-rc.1', b as 'patch'))).toEqual(['0.2.0', '0.2.0', '1.0.0']);
  });
});

