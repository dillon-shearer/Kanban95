import './home.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath } from '../src/git.ts';
import { sweep } from '../src/janitor.ts';
import { killTree, sessions, tempRoot, type Session } from '../src/launcher.ts';
import { start } from '../src/server.ts';
import { localHome, pointerPath, repoKey } from '../src/settings.ts';
import { fakeCli } from './fake-cli.ts';
import { removeTemp } from './home.ts';

const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const FAKE = `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync('fake-out.json', JSON.stringify({ env: process.env, tempExists: existsSync(process.env.TEMP ?? '') }));
console.log('FAKE UP');
setInterval(() => {}, 1000);
`;
const PATH0 = process.env.PATH;

let repo: string;
let data: string;
let srv: Awaited<ReturnType<typeof start>>;
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
const waitFor = async (f: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const fakeOut = (s: Session) => JSON.parse(readFileSync(join(worktreePath(repo, s.ticketId!), 'fake-out.json'), 'utf8'));
const launch = () => srv.launch({ ticketId: 7, template: 'execute', cli: 'codex', model: 'hang', effort: 'high' });
const envOf = (env: Record<string, string>, name: string) => env[Object.keys(env).find((k) => k.toUpperCase() === name)!];

beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), FAKE);
  fakeCli(bin, 'codex', 'fake.mjs');
  process.env.PATH = bin + delimiter + PATH0;
  data = mkdtempSync(join(tmpdir(), 'k95-data-'));
});
afterAll(() => {
  process.env.PATH = PATH0;
  rmSync(bin, { recursive: true, force: true });
  removeTemp(data);
});

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
});
afterEach(async () => {
  await srv.close();
  rmSync(pointerPath(), { force: true });
  removeTemp(repo);
});

describe('session temp folder', () => {
  it('sets TEMP, TMP and TMPDIR to <data folder>/tmp/<repo key>/<session key>, made before the agent starts and gone after it ends', async () => {
    mkdirSync(localHome(), { recursive: true });
    writeFileSync(pointerPath(), data + '\n');
    srv = await start({ repo });
    srv.db.prepare("INSERT INTO tickets (id, title, body, criteria) VALUES (7, 'T', 'b', 'c')").run();
    const s = launch();
    await waitFor(() => s.scrollback().includes('FAKE UP'));
    const dir = join(data, 'tmp', repoKey(repo), String(s.key));
    const out = fakeOut(s);
    for (const k of ['TEMP', 'TMP', 'TMPDIR']) expect(envOf(out.env, k)).toBe(dir);
    expect(out.tempExists).toBe(true);
    expect(dir.startsWith(localHome())).toBe(false);
    writeFileSync(join(dir, 'scratch.txt'), 'x');
    killTree(s.pty);
    await s.done;
    expect(existsSync(dir)).toBe(false);
  });

  it('the janitor removes a temp folder whose session is not live and keeps a live session\'s', async () => {
    srv = await start({ repo });
    srv.db.prepare("INSERT INTO tickets (id, title, body, criteria) VALUES (7, 'T', 'b', 'c')").run();
    const s = launch();
    await waitFor(() => s.scrollback().includes('FAKE UP'));
    const live = join(tempRoot(repo), String(s.key));
    const dead = join(tempRoot(repo), '999');
    const setup = join(tempRoot(repo), 'setup-12');
    mkdirSync(join(dead, 'sub'), { recursive: true });
    mkdirSync(setup, { recursive: true });
    await sweep({ db: srv.db, repo });
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(setup)).toBe(false);
    expect(sessions.has(s.key)).toBe(true);
    killTree(s.pty);
    await s.done;
  });

  it.skipIf(!!process.env.K95_NO_LINKS)('removing a temp folder unlinks a junction inside it and leaves its target', async () => {
    srv = await start({ repo });
    const target = mkdtempSync(join(tmpdir(), 'k95-target-'));
    writeFileSync(join(target, 'keep.txt'), 'keep');
    const dead = join(tempRoot(repo), '998');
    mkdirSync(dead, { recursive: true });
    execFileSync(process.platform === 'win32' ? 'cmd' : 'ln', process.platform === 'win32' ? ['/c', 'mklink', '/J', join(dead, 'link'), target] : ['-s', target, join(dead, 'link')], { stdio: 'ignore' });
    await sweep({ db: srv.db, repo });
    expect(existsSync(dead)).toBe(false);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
    removeTemp(target);
  });
});
