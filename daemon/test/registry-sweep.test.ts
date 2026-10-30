import './home.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { entryPath, register } from '../src/boards.ts';
import { localHome, pointerPath } from '../src/settings.ts';

const data = mkdtempSync(join(tmpdir(), 'k95-data-'));
afterAll(() => {
  rmSync(pointerPath(), { force: true });
  rmSync(data, { recursive: true, force: true });
});

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const fake = (dir: string, pid: number) => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${pid}.json`);
  writeFileSync(file, JSON.stringify({ pid, repo: 'D:\\gone', port: 1, started: new Date().toISOString() }));
  return file;
};

it('register removes dead entries from the data folder and the old local home, and keeps live ones', () => {
  mkdirSync(localHome(), { recursive: true });
  writeFileSync(pointerPath(), data + '\n');
  const oldDead = fake(join(localHome(), 'running'), deadPid());
  const newDead = fake(join(data, 'running'), deadPid());
  const live = fake(join(data, 'running'), process.ppid);
  const unregister = register(data, 1, null);
  expect(existsSync(oldDead)).toBe(false);
  expect(existsSync(newDead)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(entryPath(process.pid))).toBe(true);
  unregister();
});
