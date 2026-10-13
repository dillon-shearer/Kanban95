// Start -> Projects on a macOS checkout starts the dev shell binary, as on Windows, not a launcher script.
import './home.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { boards, openProject } from '../src/boards.ts';
import { writeProjects } from '../src/settings.ts';
import { removeTemp } from './home.ts';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const started: [string, string[]][] = [];
boards.start = async (cmd, args) => void started.push([cmd, args]);
let repo: string;
let root: string;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'k95-mac-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeProjects([{ path: repo, colour: 120 }], repo);
  root = mkdtempSync(join(tmpdir(), 'k95-root-'));
  mkdirSync(join(root, 'daemon', 'src'), { recursive: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
  for (const d of [repo, root]) removeTemp(d);
});

it('refuses with npm run dev when the dev shell was never built, and starts nothing', async () => {
  await expect(openProject(repo, root)).rejects.toThrow(/no shell build at .*kanban95-shell: run npm run dev once/);
  expect(started).toEqual([]);
});

it('starts shell/target/debug/kanban95-shell on the project directly', async () => {
  const exe = join(root, 'shell', 'target', 'debug', 'kanban95-shell');
  mkdirSync(join(root, 'shell', 'target', 'debug'), { recursive: true });
  writeFileSync(exe, '');
  await openProject(repo, root);
  expect(started).toEqual([[exe, [repo]]]);
});
