import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { addProject, readProjects, writeConfig, writePreferences } from '../src/settings.js';

const fail = vi.hoisted(() => ({ rename: false }));
vi.mock('node:fs', async (real) => {
  const fs = await real<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (fail.rename) throw Object.assign(new Error('EPERM: rename refused'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    },
  };
});
afterEach(() => void (fail.rename = false));

const home = process.env.KANBAN95_HOME!;
const settings = pathToFileURL(join(import.meta.dirname, '../src/settings.ts')).href;
const run = promisify(execFile);

function daemons(n: number, body: (i: number) => string) {
  return Promise.all(Array.from({ length: n }, (_, i) =>
    run(process.execPath, ['--input-type=module', '-e', `const s = await import(${JSON.stringify(settings)}); ${body(i)}`], { env: { ...process.env, KANBAN95_HOME: home } })));
}

const temps = () => readdirSync(home).filter((f) => f.endsWith('.tmp'));

it('daemons writing the global settings and preferences at once all succeed and leave one whole value and no temp files', async () => {
  const value = (i: number) => String.fromCharCode(65 + i).repeat(12_000);
  await daemons(4, (i) => `for (let k = 0; k < 40; k++) { s.writePreferences(${JSON.stringify(value(i))}); s.writeConfig('settings', { idle_minutes: ${i + 1}, concurrency: ${i + 1} }); }`);
  expect([0, 1, 2, 3].map(value)).toContain(readFileSync(join(home, 'preferences.md'), 'utf8'));
  const cfg = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  expect(cfg.concurrency).toBe(cfg.idle_minutes);
  expect(temps()).toEqual([]);
}, 60_000);

it('daemons adding projects at once keep every new project and the entries listed before', async () => {
  mkdirSync(home, { recursive: true });
  const before = { path: join(home, 'before'), colour: 200 };
  writeFileSync(join(home, 'projects.json'), JSON.stringify([before]));
  await daemons(4, (i) => `for (let k = 0; k < 15; k++) s.addProject(${JSON.stringify(join(home, `d${i}`))} + '-' + k);`);
  const paths = readProjects().map((p) => p.path);
  expect(paths).toHaveLength(61);
  expect(readProjects()[0]).toEqual(before);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 15; k++) expect(paths).toContain(join(home, `d${i}-${k}`));
  expect(temps()).toEqual([]);
}, 60_000);

it('a failed write leaves the committed file and another writer\'s temp file alone and removes only its own temp file', () => {
  writeConfig('settings', { zoom: 1.5 });
  writePreferences('kept');
  writeFileSync(join(home, 'projects.json'), '[]');
  const other = join(home, 'settings.json.1-other.tmp');
  writeFileSync(other, 'another writer');
  fail.rename = true;
  expect(() => writeConfig('settings', { zoom: 2 })).toThrow(/EPERM/);
  expect(() => writePreferences('lost')).toThrow(/EPERM/);
  expect(() => addProject(join(home, 'new'))).toThrow(/EPERM/);
  fail.rename = false;
  expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).zoom).toBe(1.5);
  expect(readFileSync(join(home, 'preferences.md'), 'utf8')).toBe('kept');
  expect(readProjects()).toEqual([]);
  expect(temps()).toEqual(['settings.json.1-other.tmp']);
  expect(readFileSync(other, 'utf8')).toBe('another writer');
});
