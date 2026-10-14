import './home.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { globalPath, lastBoardPath, normal, projectsPath, writeConfig } from '../src/settings.ts';
import { startupProject } from '../src/setup.ts';
import { removeTemp } from './home.ts';

const dir = () => normal(mkdtempSync(join(tmpdir(), 'k95-start-')));
const [a, b, c] = [dir(), dir(), dir()];
const gone = join(tmpdir(), 'k95-start-gone-never-made');
afterAll(() => [a, b, c].forEach(removeTemp));
afterEach(() => [projectsPath(), globalPath('settings'), lastBoardPath()].forEach((f) => rmSync(f, { force: true })));

const list = (...paths: string[]) => {
  mkdirSync(join(projectsPath(), '..'), { recursive: true });
  writeFileSync(projectsPath(), JSON.stringify(paths.map((path) => ({ path, colour: '#008080' }))));
};
const last = (text: string) => writeFileSync(lastBoardPath(), text);
const startup = (value: string) => writeConfig('settings', { startup: value });

describe('startup board pick order', () => {
  it('a startup path that exists wins over the last board and the first project', () => {
    list(a, b);
    last(`${b}\n`);
    startup(c);
    expect(startupProject()).toBe(c);
  });

  it('a startup path whose folder is gone falls through to the last board', () => {
    list(a, b);
    last(`${b}\n`);
    startup(gone);
    expect(startupProject()).toBe(b);
  });

  it('with startup "last", a listed and present last board wins over the first project', () => {
    list(a, b);
    last(`${b}\n`);
    startup('last');
    expect(startupProject()).toBe(b);
  });

  it('a last board not in projects.json falls through to the first project', () => {
    list(a, b);
    last(`${c}\n`);
    expect(startupProject()).toBe(a);
  });

  it('a listed last board whose folder is gone falls through to the first project', () => {
    list(a, gone);
    last(`${gone}\n`);
    expect(startupProject()).toBe(a);
  });

  it('a missing or unparsable last-board file is ignored', () => {
    list(a, b);
    expect(startupProject()).toBe(a);
    last('not a path\0\n');
    expect(startupProject()).toBe(a);
  });
});

describe('startup setting schema', () => {
  it('accepts "last" and an absolute path, and rejects anything else', () => {
    expect(writeConfig('settings', {}).startup).toBe('last');
    expect(writeConfig('settings', { startup: 'last' }).startup).toBe('last');
    expect(writeConfig('settings', { startup: a }).startup).toBe(a);
    for (const bad of ['', 'first', 'relative/folder', 5, null]) expect(() => writeConfig('settings', { startup: bad })).toThrow(/startup/);
  });
});

describe('POST /api/last-board', () => {
  let repo: string;
  let srv: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    repo = dir();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    srv = await start({ repo });
  });
  afterAll(async () => {
    await srv?.close();
    removeTemp(repo);
  });
  const call = (body: unknown) => fetch(`http://127.0.0.1:${srv.port}/api/last-board`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` },
    body: JSON.stringify(body),
  });

  it('from the main window, writes the canonical repo path to <data folder>/last-board', async () => {
    expect((await call({})).status).toBe(204);
    expect(readFileSync(lastBoardPath(), 'utf8')).toBe(`${normal(repo)}\n`);
  });

  it('from a popped-out window, writes nothing', async () => {
    expect((await call({ window: 'own' })).status).toBe(204);
    expect(existsSync(lastBoardPath())).toBe(false);
  });
});
