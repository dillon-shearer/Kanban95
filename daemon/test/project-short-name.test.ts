import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { addProject, project, readProjects } from '../src/settings.ts';
import { removeTemp } from './home.ts';

const root = mkdtempSync(join(tmpdir(), 'k95-short-'));
afterAll(() => removeTemp(root));

const shortName = (p: string) =>
  execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();

it.runIf(process.platform === 'win32')('a project given by its 8.3 short name is the same project as its long name', (ctx) => {
  const long = join(root, 'a long project folder name');
  mkdirSync(long);
  const short = shortName(long);
  if (short.toLowerCase() === long.toLowerCase()) ctx.skip();
  addProject(short);
  addProject(long);
  expect(readProjects().map((p) => p.path)).toEqual([long]);
  expect(project(short).path).toBe(long);
});
