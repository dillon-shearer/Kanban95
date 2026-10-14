import './home.ts';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { foreign, pointerPath, projectsPath } from '../src/settings.ts';

describe('a project path from the other machine', () => {
  it('on macOS a Windows path is foreign', () => {
    expect(foreign('D:\\projects\\WinOnly', posix)).toBe(true);
    expect(foreign('d:/projects/WinOnly', posix)).toBe(true);
    expect(foreign('\\\\nas\\share\\WinOnly', posix)).toBe(true);
  });

  it('on macOS a Mac path or a bare name is not', () => {
    expect(foreign('/Users/op/projects/Kanban95', posix)).toBe(false);
    expect(foreign('/Volumes/Passport/projects/Kanban95', posix)).toBe(false);
    expect(foreign('projects/Kanban95', posix)).toBe(false);
    expect(foreign('\\projects\\Kanban95', posix)).toBe(false);
  });

  it('on Windows nothing is foreign, so validation stays as it was', () => {
    expect(foreign('D:\\projects\\WinOnly', win32)).toBe(false);
    expect(foreign('/Users/op/projects/Kanban95', win32)).toBe(false);
  });
});

describe.runIf(process.platform !== 'win32')('PUT /api/projects on macOS with a Windows entry', () => {
  const win = { path: 'D:\\projects\\WinOnly', colour: '#800000' };
  let base: string;
  let repo: string;
  let other: string;
  let srv: Awaited<ReturnType<typeof start>>;
  const put = async (value: unknown) => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/projects`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` },
      body: JSON.stringify({ value }),
    });
    return { status: r.status, body: await r.json() };
  };
  const file = () => JSON.parse(readFileSync(projectsPath(), 'utf8'));
  const raw = () => readFileSync(projectsPath(), 'utf8');

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'k95-foreign-')));
    repo = join(base, 'repo');
    other = join(base, 'other');
    for (const d of [repo, other]) mkdirSync(d);
    mkdirSync(process.env.KANBAN95_HOME!, { recursive: true });
    rmSync(pointerPath(), { force: true });
    writeFileSync(projectsPath(), JSON.stringify([win, { path: repo, colour: '#008080' }], null, 2) + '\n');
    srv = await start({ repo });
  }, 30_000);
  afterAll(async () => {
    await srv.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('the daemon start keeps it and GET still marks it missing', async () => {
    expect(file()).toEqual([win, { path: repo, colour: '#008080' }]);
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/projects`, { headers: { cookie: `k95=${srv.secret}` } });
    const body = await r.json();
    expect(body.value).toContainEqual(win);
    expect(body.missing[win.path]).toBe(true);
  });

  it('add, colour change and removing another project all keep it byte for byte', async () => {
    expect((await put([win, { path: repo, colour: '#008080' }, { path: other, colour: 30 }])).status).toBe(200);
    expect(file()).toEqual([win, { path: repo, colour: '#008080' }, { path: other, colour: 30 }]);
    expect((await put([win, { path: repo, colour: 120 }, { path: other, colour: 30 }])).status).toBe(200);
    expect((await put([win, { path: repo, colour: 120 }])).status).toBe(200);
    expect(raw()).toContain('"path": "D:\\\\projects\\\\WinOnly",\n    "colour": "#800000"');
    expect(file()).toEqual([win, { path: repo, colour: 120 }]);
  });

  it('it can still be removed on purpose', async () => {
    expect((await put([{ path: repo, colour: 120 }])).status).toBe(200);
    expect(file()).toEqual([{ path: repo, colour: 120 }]);
  });

  it('a missing Mac folder is still refused with the same message', async () => {
    const gone = join(base, 'gone');
    const r = await put([{ path: repo, colour: 120 }, { path: gone, colour: 30 }]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(`projects.json: ${gone} is not a folder`);
  });
});
