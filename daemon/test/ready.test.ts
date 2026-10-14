import './home.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { worktreesRoot } from '../src/git.ts';
import { killTree, sessions } from '../src/launcher.ts';
import { readiness } from '../src/ready.ts';
import { start } from '../src/server.ts';
import { removeTemp } from './home.ts';

const FAKE = `
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const brief = /^Read (\\S+) in full/.exec(argv.at(-1))?.[1];
if (brief) copyFileSync(brief, join(import.meta.dirname, 'brief.md'));
console.log('FAKE UP');
process.stdin.resume();
`;
const PATH0 = process.env.PATH;
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const models = join(process.env.USERPROFILE!, '.kanban95', 'models.json');
let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
const req = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${srv.port}/api${path}`, {
    method, headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(r.status, await r.clone().text()).toBeLessThan(300);
  return r.json();
};
const item = (r: { items: { id: string; ok: boolean; fix: string }[] }, id: string) => r.items.find((i) => i.id === id)!;

async function brainstormBrief() {
  rmSync(join(bin, 'brief.md'), { force: true });
  const { id } = await req('POST', '/brainstorm', {});
  const s = sessions.get(id)!;
  const t0 = Date.now();
  while (!s.scrollback().includes('FAKE UP')) {
    if (Date.now() - t0 > 20_000) throw new Error(`fake never came up: ${s.scrollback().slice(-500)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  killTree(s.pty);
  await s.done;
  return readFileSync(join(bin, 'brief.md'), 'utf8');
}

beforeAll(async () => {
  const script = join(bin, 'fake.mjs');
  writeFileSync(script, FAKE);
  if (process.platform === 'win32') writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${script}" %*
`);
  else writeFileSync(join(bin, 'claude'), `#!/bin/sh
exec "${process.execPath}" "${script}" "$@"
`, { mode: 0o755 });
  process.env.PATH = bin + delimiter + PATH0;
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Op Erator');
  git('config', 'user.email', 'op@example.com');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  srv = await start({ repo });
}, 60_000);
afterAll(async () => {
  await srv.close();
  process.env.PATH = PATH0;
  removeTemp(repo);
  removeTemp(bin);
});

it('a board with no models.json is not ready and says how to fix models', async () => {
  expect(existsSync(models)).toBe(false);
  const r = await req('GET', '/ready');
  expect(r.ready).toBe(false);
  expect(item(r, 'models').ok).toBe(false);
  expect(item(r, 'models').fix).toMatch(/models/);
  expect(r.items.map((i: { id: string }) => i.id)).toEqual(['git', 'identity', 'commit', 'clean', 'models', 'cli', 'trust', 'runner']);
});

it('the clean item fails while a tracked file on the base is modified', async () => {
  writeFileSync(join(repo, 'a.txt'), 'changed\n');
  const dirty = item(await readiness(srv.board), 'clean');
  expect(dirty.ok).toBe(false);
  expect(dirty.fix).toMatch(/uncommitted changes \(1 modified\)/);
  git('checkout', '--', 'a.txt');
  expect(item(await readiness(srv.board), 'clean')).toEqual({ id: 'clean', ok: true, fix: '' });
});

it('a brainstorm brief lists what is not ready, then says ready once everything is set', async () => {
  mkdirSync(join(process.env.USERPROFILE!, '.kanban95'), { recursive: true });
  writeFileSync(models, JSON.stringify({ cli: 'claude', claude: { plan: { model: 'p', effort: 'low' }, execute: { model: 'e', effort: 'low' }, test: { model: 't', effort: 'low' } } }));
  const before = await req('GET', '/ready');
  expect(before.items.filter((i: { ok: boolean }) => !i.ok).map((i: { id: string }) => i.id)).toEqual(['trust', 'runner']);
  const notReady = await brainstormBrief();
  expect(notReady).toContain(`- trust: ${item(before, 'trust').fix}\n- runner: ${item(before, 'runner').fix}`);

  writeFileSync(join(process.env.USERPROFILE!, '.claude.json'), JSON.stringify({ projects: { [worktreesRoot(repo).replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } }));
  const runnerFile = join(repo, '.kanban95', 'runner.json');
  writeFileSync(runnerFile, JSON.stringify({ on: true }));
  try {
    const r = await req('GET', '/ready');
    expect(r).toEqual({ ready: true, items: r.items.map((i: { id: string }) => ({ id: i.id, ok: true, fix: '' })) });
    expect(await brainstormBrief()).toMatch(/before anything else\.\n\nready\n/);
  } finally {
    rmSync(runnerFile, { force: true });
  }
}, 60_000);
