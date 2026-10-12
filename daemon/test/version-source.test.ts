import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const json = (p: string) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));

test('the shell takes its version from the root package.json', () => {
  expect(json('shell/tauri.conf.json').version).toBe('../package.json');
});

test('no other package or Tauri config carries its own version', () => {
  const files = ['daemon/package.json', ...readdirSync(resolve(root, 'shell')).filter((f) => /^tauri\..+\.json$/.test(f) && f !== 'tauri.conf.json').map((f) => `shell/${f}`)];
  expect(files).toContain('shell/tauri.bundle.json');
  for (const f of files) expect(json(f), f).not.toHaveProperty('version');
});
