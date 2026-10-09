import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configPath, readPreferences, writeConfig, writePreferences } from '../src/settings.js';

const set = process.env.KANBAN95_HOME!;
afterEach(() => void (process.env.KANBAN95_HOME = set));

it('under vitest without KANBAN95_HOME, every config read and write throws and nothing lands in the home', () => {
  delete process.env.KANBAN95_HOME;
  expect(() => writeConfig('settings', {})).toThrow(/KANBAN95_HOME/);
  expect(() => writePreferences('x')).toThrow(/KANBAN95_HOME/);
  expect(() => readPreferences()).toThrow(/KANBAN95_HOME/);
  expect(existsSync(join(homedir(), '.kanban95'))).toBe(false);
});

it('with KANBAN95_HOME set, config is read from and written to that directory', () => {
  expect(set).toBeTruthy();
  writeConfig('settings', {});
  expect(configPath('settings')).toBe(join(set, 'settings.json'));
  expect(existsSync(join(set, 'settings.json'))).toBe(true);
  writePreferences('be brief');
  expect(readFileSync(join(set, 'preferences.md'), 'utf8')).toBe('be brief');
  expect(readPreferences()).toBe('be brief');
});

it('housekeeping defaults to on every 10 merges and refuses an interval under 1 or fractional', () => {
  expect(writeConfig('settings', {}).housekeeping).toEqual({ auto: true, every: 10 });
  expect(() => writeConfig('settings', { housekeeping: { every: 0 } })).toThrow(/every/);
  expect(() => writeConfig('settings', { housekeeping: { every: 2.5 } })).toThrow(/every/);
});
