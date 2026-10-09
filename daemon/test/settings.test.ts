import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configPath, readPreferences, runSettings, writeConfig, writePreferences } from '../src/settings.js';

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

it('runSettings refuses a model outside the cli models list, naming the model, the cli and the file; no list means no check', () => {
  const t = (model: string | null) => ({ model, cli: null, effort: null }) as never;
  writeConfig('models', { cli: 'claude', claude: { models: ['a'], execute: { model: 'a' }, test: { model: 'zz' } } });
  const file = configPath('models');
  expect(runSettings(t(null), 'execute').model).toBe('a');
  expect(() => runSettings(t('b'), 'execute')).toThrow(`model b is not in the claude model list in ${file}`);
  expect(() => runSettings(null, 'test')).toThrow(`model zz is not in the claude model list in ${file}`);
  writeConfig('models', { cli: 'claude', claude: { execute: { model: 'a' } } });
  expect(runSettings(t('b'), 'execute').model).toBe('b');
});

it('the old single sounds boolean carries over to both sounds; a missing one keeps both on', () => {
  expect(writeConfig('settings', { sounds: false }).sounds).toEqual({ merge: false, attention: false });
  expect(writeConfig('settings', { sounds: true }).sounds).toEqual({ merge: true, attention: true });
  expect(writeConfig('settings', {}).sounds).toEqual({ merge: true, attention: true });
  expect(writeConfig('settings', { sounds: { merge: false } }).sounds).toEqual({ merge: false, attention: true });
  expect(() => writeConfig('settings', { sounds: 'off' })).toThrow();
});

it('housekeeping defaults to on every 10 merges and refuses an interval under 1 or fractional', () => {
  expect(writeConfig('settings', {}).housekeeping).toEqual({ auto: true, every: 10 });
  expect(() => writeConfig('settings', { housekeeping: { every: 0 } })).toThrow(/every/);
  expect(() => writeConfig('settings', { housekeeping: { every: 2.5 } })).toThrow(/every/);
});

it('terminals open on their own for plan and execute by default; only plan, execute and test are accepted', () => {
  expect(writeConfig('settings', {}).terminals).toEqual({ auto: ['plan', 'execute'] });
  expect(writeConfig('settings', { terminals: { auto: [] } }).terminals.auto).toEqual([]);
  expect(writeConfig('settings', { terminals: { auto: ['test'] } }).terminals.auto).toEqual(['test']);
  expect(() => writeConfig('settings', { terminals: { auto: ['operator'] } })).toThrow(/terminals/);
  expect(() => writeConfig('settings', { terminals: { auto: 'test' } })).toThrow(/terminals/);
});
