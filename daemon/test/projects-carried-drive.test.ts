import './home.ts';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { start } from '../src/server.ts';
import { addProject, pointerPath, projectsPath, readProjects, writeProjects } from '../src/settings.ts';

const fake = vi.hoisted(() => ({ dir: '', root: '' }));
vi.mock('node:path', async (orig) => {
  const real = await orig<typeof import('node:path')>();
  const parse = (p: string) => {
    const r = real.parse(p);
    return fake.dir && p.toLowerCase().startsWith(fake.dir.toLowerCase()) ? { ...r, root: fake.root } : r;
  };
  return { ...real, parse, default: { ...real, parse } };
});

describe.runIf(process.platform === 'win32')('projects.json on a carried drive', () => {
  let base: string;
  let data: string;
  let moved: string;
  let repo: string;
  let rel: string;
  const file = () => JSON.parse(readFileSync(projectsPath(), 'utf8'));
  const point = (dir: string) => writeFileSync(pointerPath(), dir + '\n');

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'k95-carried-'));
    data = join(base, 'data');
    moved = join(base, 'moved');
    repo = join(base, 'repo');
    for (const d of [data, moved, repo]) mkdirSync(d);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    rel = repo.slice(parse(repo).root.length);
    mkdirSync(process.env.KANBAN95_HOME!, { recursive: true });
  });
  afterAll(() => {
    rmSync(pointerPath(), { force: true });
    rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  });

  it('a project on the data folder\'s volume is written relative to it and read back absolute', () => {
    point(data);
    addProject(repo);
    expect(file()).toEqual([{ path: rel, root: 'data', colour: '#008080' }]);
    expect(readProjects()).toEqual([{ path: repo, colour: '#008080' }]);
    writeProjects([{ path: repo, colour: 120 }], repo);
    expect(file()).toEqual([{ path: rel, root: 'data', colour: 120 }]);
  });

  it('the same entry resolves under the volume the data folder is on now', () => {
    copyFileSync(projectsPath(), join(moved, 'projects.json'));
    point(moved);
    fake.dir = moved;
    fake.root = 'Z:\\';
    try {
      expect(readProjects()).toEqual([{ path: join('Z:\\', rel), colour: 120 }]);
    } finally {
      fake.dir = '';
    }
  });

  it('a project on another volume is stored absolute, as before', () => {
    point(data);
    writeFileSync(projectsPath(), '[]\n');
    fake.dir = data;
    fake.root = 'Z:\\';
    try {
      writeProjects([{ path: repo, colour: '#008080' }], repo);
    } finally {
      fake.dir = '';
    }
    expect(readFileSync(projectsPath(), 'utf8')).toBe(JSON.stringify([{ path: repo, colour: '#008080' }], null, 2) + '\n');
  });

  it('GET /api/projects returns absolute paths for relative and absolute entries', async () => {
    point(data);
    const other = join(base, 'other');
    mkdirSync(other);
    writeFileSync(projectsPath(), JSON.stringify([{ path: rel, root: 'data', colour: '#008080' }, { path: other, colour: 30 }]));
    const srv = await start({ repo });
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/projects`, { headers: { cookie: `k95=${srv.secret}` } });
      expect((await r.json()).value).toEqual([{ path: repo, colour: '#008080' }, { path: other, colour: 30 }]);
    } finally {
      await srv.close();
    }
  }, 30_000);
});
