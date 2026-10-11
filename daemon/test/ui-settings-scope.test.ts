import './home.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { events } from '../src/lifecycle.ts';
import { projectPath } from '../src/settings.ts';
import { page, base, repo, statusBar } from './ui.ts';

const globalFile = (f: string) => join(process.env.KANBAN95_HOME!, f);
const ownFile = (name: 'models' | 'settings' | 'preferences') => projectPath(name, repo);
const W = '[data-win="settings"]';
const js = (s: string) => JSON.stringify(s);
const tab = (name: string) => page.evaluate(`[...document.querySelectorAll('${W} [role=tab] a')].find((t) => t.textContent === ${js(name)}).click()`);
const bar = (file: string) => page.evaluate<string | null>(`document.querySelector('${W} .k95-scope-bar[data-file=${file}] button')?.textContent ?? null`);
const pressBar = (file: string) => page.evaluate(`document.querySelector('${W} .k95-scope-bar[data-file=${file}] button').click()`);
const greyed = (file: string) => page.evaluate<boolean>(`document.querySelector('${W} .k95-scoped[data-file=${file}]').disabled`);
const save = (file: string) => page.evaluate(`[...document.querySelectorAll('${W} .k95-scoped[data-file=${file}] button')].at(-1).click()`);
const confirmDialog = async (label: string) => {
  await until(() => page.evaluate(`!!document.querySelector('.k95-dialog')`), 'the confirm');
  await page.evaluate(`[...document.querySelectorAll('.k95-dialog button')].find((b) => b.textContent === ${js(label)}).click()`);
  await until(() => page.evaluate(`!document.querySelector('.k95-dialog')`), 'the confirm closed');
};
const executeModel = () => page.evaluate<string>(`[...document.querySelectorAll('${W} .k95-models tr')].find((r) => r.firstChild.textContent === 'execute').querySelector('input').value`);

async function openSettings() {
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await until(() => page.evaluate(`!!document.querySelector('#scope-project')`), 'the switch');
}
async function thisProject() {
  await page.evaluate(`(() => { const r = document.querySelector('#scope-project'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
}

describe('ui-settings-scope', { timeout: 60_000 }, () => {
  afterEach(() => { for (const f of ['models', 'settings', 'preferences'] as const) rmSync(ownFile(f), { force: true }); });

  it('Agents: Customize starts this project\'s models.json, Save writes only the copy, and Use the global settings again removes it after the confirm', async () => {
    const global = readFileSync(globalFile('models.json'), 'utf8');
    await openSettings();
    await until(() => page.evaluate(`!!document.querySelector('#concurrency')`), 'the Agents tab');
    expect(await page.evaluate(`document.querySelector('label[for=concurrency]').textContent`)).toBe('Tickets running at once (this project)');
    expect(await bar('models')).toBe(null);
    expect(await page.evaluate(`document.querySelector('${W} .title-bar-text').textContent`)).toBe('Settings');

    await thisProject();
    await until(async () => (await bar('models')) === 'Customize for this project', 'the Customize button');
    expect(await greyed('models')).toBe(true);
    expect(await executeModel()).toBe('work');
    expect(await page.evaluate(`document.querySelector('${W} .k95-scope-bar[data-file=models] span').textContent`)).toBe('Uses the global settings');
    expect(await page.evaluate(`document.querySelector('label[for=concurrency]').textContent`)).toBe('Tickets running at once (this project)');
    expect(await page.evaluate(`document.querySelector('#concurrency').disabled`)).toBe(false);
    await until(async () => (await page.evaluate<string>(`document.querySelector('${W} .title-bar-text').textContent`)) === `Settings: ${basename(repo)}`, 'the scoped title');

    await pressBar('models');
    await until(async () => (await bar('models')) === 'Use the global settings again', 'the copy in the form');
    expect(existsSync(ownFile('models'))).toBe(true);
    expect(await greyed('models')).toBe(false);
    await page.evaluate(`[...document.querySelectorAll('${W} .k95-models tr')].find((r) => r.firstChild.textContent === 'execute').querySelector('input').value = 'project-m'`);
    await save('models');
    await until(() => JSON.parse(readFileSync(ownFile('models'), 'utf8')).claude?.execute?.model === 'project-m', 'the model in the project copy');
    expect(readFileSync(globalFile('models.json'), 'utf8')).toBe(global);

    await pressBar('models');
    await confirmDialog('Cancel');
    expect(existsSync(ownFile('models'))).toBe(true);
    await pressBar('models');
    await confirmDialog('Use global');
    await until(async () => (await bar('models')) === 'Customize for this project', 'the greyed view again');
    expect(existsSync(ownFile('models'))).toBe(false);
    expect(await greyed('models')).toBe(true);
    expect(await executeModel()).toBe('work');
    expect(readFileSync(globalFile('models.json'), 'utf8')).toBe(global);
  });

  it('Board and Preferences each have their own Customize and Use global buttons, on settings.json and preferences.md', async () => {
    writeFileSync(globalFile('settings.json'), JSON.stringify({ sounds: { merge: true, attention: true, done: true } }));
    const global = readFileSync(globalFile('settings.json'), 'utf8');
    try {
      await openSettings();
      await thisProject();
      await tab('Board');
      await until(async () => (await bar('settings')) === 'Customize for this project', 'the Board Customize button');
      expect(await greyed('settings')).toBe(true);
      await pressBar('settings');
      await until(async () => (await bar('settings')) === 'Use the global settings again', 'the settings copy in the form');
      await page.evaluate(`document.querySelector('#sound-merge').click()`);
      await until(() => JSON.parse(readFileSync(ownFile('settings'), 'utf8')).sounds?.merge === false, 'the sound off in the project copy');
      await until(async () => (await statusBar()) === 'Saved.', 'the save');
      expect(readFileSync(globalFile('settings.json'), 'utf8')).toBe(global);
      expect(existsSync(ownFile('models'))).toBe(false);

      await tab('Prompts');
      await until(async () => (await bar('preferences')) === 'Customize for this project', 'the Preferences Customize button');
      expect(await page.evaluate(`document.querySelector('#template-text').disabled`)).toBe(false);
      await pressBar('preferences');
      await until(async () => (await bar('preferences')) === 'Use the global settings again', 'the preferences copy in the form');
      await page.evaluate(`document.querySelector('#preferences').value = 'project only'`);
      await save('preferences');
      await until(() => existsSync(ownFile('preferences')) && readFileSync(ownFile('preferences'), 'utf8') === 'project only', 'preferences.md copy');
      expect(existsSync(globalFile('preferences.md'))).toBe(false);
      await pressBar('preferences');
      await confirmDialog('Use global');
      await until(async () => (await bar('preferences')) === 'Customize for this project', 'preferences greyed again');
      expect(existsSync(ownFile('preferences'))).toBe(false);

      await tab('Board');
      await until(async () => (await bar('settings')) === 'Use the global settings again', 'the Board copy kept');
      await pressBar('settings');
      await confirmDialog('Use global');
      await until(async () => (await bar('settings')) === 'Customize for this project', 'settings greyed again');
      expect(existsSync(ownFile('settings'))).toBe(false);
      expect(await page.evaluate(`document.querySelector('#sound-merge').checked`)).toBe(true);
    } finally {
      rmSync(globalFile('settings.json'), { force: true });
      for (const f of ['settings', 'preferences'] as const) rmSync(ownFile(f), { force: true });
    }
  });

  it('a reload runs on this project\'s settings.json: its sounds off silence a merge the global file would ring, and the switch is back on All projects', async () => {
    writeFileSync(globalFile('settings.json'), JSON.stringify({ sounds: { merge: true, attention: true, done: true } }));
    mkdirSync(dirname(ownFile('settings')), { recursive: true });
    writeFileSync(ownFile('settings'), JSON.stringify({ sounds: { merge: false, attention: true, done: true } }));
    try {
      await openSettings();
      expect(await page.evaluate(`document.querySelector('#scope-global').checked`)).toBe(true);
      await page.evaluate(`window.played = []; window.Audio = class { constructor(src) { window.played.push(src); } play() { return Promise.resolve(); } }`);
      events.emit('event', { sound: 'ding', ticket: 41 });
      await until(async () => (await statusBar()) === '#41 merged.', 'the merge message');
      expect(await page.evaluate(`window.played`)).toEqual([]);
      events.emit('event', { sound: 'done', ticket: 42 });
      await until(async () => (await statusBar()) === '#42 passed, in Done.', 'the done message');
      expect(await page.evaluate(`window.played`)).toEqual(['sounds/done.wav']);
    } finally {
      rmSync(globalFile('settings.json'), { force: true });
      rmSync(ownFile('settings'), { force: true });
    }
  });
});
