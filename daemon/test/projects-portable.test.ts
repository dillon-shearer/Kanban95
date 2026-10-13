import './home.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BadConfig, gone, loadProject, local, pointerPath, projectsPath, readProjects, storeProject } from '../src/settings.ts';

const colour = '#008080';

describe('projects.json between Windows and macOS', () => {
  it('Windows stores a project on the data folder\'s drive relative to it with a forward slash', () => {
    const root = win32.parse('D:\\Kanban95-data').root;
    expect(storeProject({ path: 'D:\\projects\\Kanban95', colour }, root, win32)).toEqual({ path: 'projects/Kanban95', root: 'data', colour });
  });

  it('macOS reads that entry under the volume its data folder is on', () => {
    expect(loadProject({ path: 'projects/Kanban95', root: 'data', colour }, '/Volumes/Passport/Kanban95-data', posix))
      .toEqual({ path: '/Volumes/Passport/projects/Kanban95', colour });
  });

  it('macOS stores relative to /Volumes/<name>/ and Windows reads it back on its drive', () => {
    const stored = storeProject({ path: '/Volumes/Passport/projects/Kanban95', colour }, '/Volumes/Passport/', posix);
    expect(stored).toEqual({ path: 'projects/Kanban95', root: 'data', colour });
    expect(loadProject(stored as { path: string; root: 'data'; colour: string }, 'E:\\Kanban95-data', win32)).toEqual({ path: 'E:\\projects\\Kanban95', colour });
  });

  it('an older entry written with a backslash resolves on both platforms', () => {
    const old = { path: 'projects\\Kanban95', root: 'data' as const, colour };
    expect(loadProject(old, 'D:\\Kanban95-data', win32).path).toBe('D:\\projects\\Kanban95');
    expect(loadProject(old, '/Volumes/Passport/Kanban95-data', posix).path).toBe('/Volumes/Passport/projects/Kanban95');
  });

  it('a root "data" entry with the data folder on no known volume reads as gone and is stored back unchanged', () => {
    const p = loadProject({ path: 'projects\\Kanban95', root: 'data', colour }, '/home/op/Kanban95-data', posix);
    expect(local(p.path, posix)).toBe(false);
    expect(gone(p.path)).toBe(true);
    expect(storeProject(p, undefined, posix)).toEqual({ path: 'projects/Kanban95', root: 'data', colour });
  });

  it('an absolute path from the other platform is not local', () => {
    expect(local('D:\\projects\\Kanban95', posix)).toBe(false);
    expect(local('/Users/op/projects/Kanban95', win32)).toBe(false);
    expect(local('\\Users\\op', win32)).toBe(false);
    expect(local('D:\\projects\\Kanban95', win32)).toBe(true);
    expect(local('\\\\nas\\share\\Kanban95', win32)).toBe(true);
    expect(local('/Users/op/projects/Kanban95', posix)).toBe(true);
  });
});

describe('reading projects.json on this machine', () => {
  const foreign = process.platform === 'win32' ? '/Users/op/projects/Kanban95' : 'D:\\projects\\Kanban95';
  beforeAll(() => {
    mkdirSync(process.env.KANBAN95_HOME!, { recursive: true });
    rmSync(pointerPath(), { force: true });
  });
  afterEach(() => rmSync(projectsPath(), { force: true }));

  it('an absolute path from the other platform reads as gone, not as a broken file', () => {
    writeFileSync(projectsPath(), JSON.stringify([{ path: foreign, colour: 30 }]));
    const list = readProjects();
    expect(list).toEqual([{ path: foreign, colour: 30 }]);
    expect(gone(list[0].path)).toBe(true);
  });

  it('a validation failure names the file and the entry\'s path, not its index', () => {
    writeFileSync(projectsPath(), JSON.stringify([{ path: foreign, colour: 30 }, { path: 'projects/Kanban95', colour: 30 }]));
    let err: unknown;
    try {
      readProjects();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadConfig);
    const msg = (err as Error).message;
    expect(msg).toContain(projectsPath());
    expect(msg).toContain('"projects/Kanban95"');
    expect(msg).not.toContain('[0]');
    expect(msg).not.toContain('[1]');
  });
});
