import './home.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { FIRST_COMMIT_MAX_BYTES, initRepo } from '../src/git.ts';
import { removeTemp } from './home.ts';

const CLEARED = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_GLOBAL'];
const saved = Object.fromEntries(CLEARED.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of CLEARED) delete process.env[k];
  writeFileSync(join(process.env.USERPROFILE!, '.gitconfig'), '[user]\n\tname = Op Erator\n\temail = op@example.com\n');
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let dir: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const committed = () => git('ls-tree', '-r', '--name-only', 'HEAD').split('\n');
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'k95-large-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  removeTemp(dir);
});

it('leaves a file over the limit out of the first commit, ignores it and names it in the log', () => {
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data', 'big [1].bin'), Buffer.alloc(FIRST_COMMIT_MAX_BYTES + 1));
  writeFileSync(join(dir, 'edge.bin'), Buffer.alloc(FIRST_COMMIT_MAX_BYTES));
  writeFileSync(join(dir, 'notes.txt'), 'hi');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  initRepo(dir);
  expect(git('rev-list', '--count', 'HEAD')).toBe('1');
  expect(committed().sort()).toEqual(['.gitignore', 'edge.bin', 'notes.txt']);
  expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n/data/big \\[1].bin\n');
  expect(git('status', '--porcelain')).toBe('');
  expect(log.mock.calls.flat().join('\n')).toMatch(/left out of the first commit, over 10 MB.*data\/big \[1\]\.bin.*remove its line from \.gitignore/);
});

it('commits a folder of small files once, with no added ignore lines', () => {
  writeFileSync(join(dir, 'a.txt'), 'a');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.txt'), 'b');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  initRepo(dir);
  expect(git('rev-list', '--count', 'HEAD')).toBe('1');
  expect(committed().sort()).toEqual(['.gitignore', 'a.txt', 'sub/b.txt']);
  expect(readFileSync(join(dir, '.gitignore'), 'utf8')).not.toMatch(/^\//m);
});
