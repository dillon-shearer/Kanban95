// In headless Edge or Chrome against a running daemon (setup in ui.ts): the release-pending text and Start -> Release board.
import './home.ts';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { changed } from '../src/lifecycle.ts';
import { globalPath } from '../src/settings.ts';
import { until } from './cdp.ts';
import { srv, page, base, click, menuPick, repo } from './ui.ts';

const settings = () => globalPath('settings');
const setRelease = (on: boolean) => writeFileSync(settings(), JSON.stringify({ release: on }));
const lookLikeKanban95 = (yes: boolean) => {
  if (!yes) return void rmSync(join(repo, 'shell'), { recursive: true, force: true });
  mkdirSync(join(repo, 'shell'), { recursive: true });
  writeFileSync(join(repo, 'shell', 'tauri.conf.json'), '{}\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'kanban95', version: '1.2.3' }));
};
afterAll(() => {
  rmSync(settings(), { force: true });
  lookLikeKanban95(false);
});
const startEntries = async () => {
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await click('#start');
  await until(() => page.evaluate(`!!document.querySelector('.k95-menu')`), 'the Start menu');
  const labels = await page.evaluate<string[]>(`[...document.querySelectorAll('.k95-menu > li')].map((li) => li.firstChild?.textContent ?? '-')`);
  await page.evaluate(`document.querySelector('.k95-menu').remove()`);
  return labels;
};
const boardTab = async () => {
  await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Board').click()`);
  await until(() => page.evaluate(`!!document.querySelector('#update-check')`), 'the Board tab');
};

describe('ui-release', { timeout: 60_000 }, () => {
  it('shows release pending in the Board status bar while GET /api/runner reports it', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const field = () => page.evaluate<[string, boolean]>(`(() => { const f = document.querySelector('.k95-release-pending'); return [f.textContent, f.hidden]; })()`);
    expect((await field())[1]).toBe(true);
    try {
      srv.board.release = { since: 'v1.2.3', commits: 4 };
      changed(null);
      await until(async () => !(await field())[1], 'the release text');
      expect(await field()).toEqual(['release pending (4 commits since v1.2.3)', false]);
    } finally {
      srv.board.release = undefined;
      changed(null);
    }
    await until(async () => (await field())[1], 'the release text gone');
  });

  it('Start has no Release board entry and Settings no checkbox outside the Kanban95 repo, even with release on', async () => {
    lookLikeKanban95(false);
    setRelease(true);
    expect(await startEntries()).not.toContain('Release board…');
    await boardTab();
    expect(await page.evaluate(`!!document.querySelector('#release-board')`)).toBe(false);
  });

  it('on the Kanban95 repo, Start shows Release board only once the Settings checkbox turns release on', async () => {
    lookLikeKanban95(true);
    rmSync(settings(), { force: true });
    const entries = await startEntries();
    expect(entries).not.toContain('Release board…');
    expect(entries.slice(entries.indexOf('Restart board'), entries.indexOf('Restart board') + 2)).toEqual(['Restart board', '-']);
    await boardTab();
    expect(await page.evaluate(`document.querySelector('label[for="release-board"]').textContent`)).toBe('Show Release board');
    await page.evaluate(`document.querySelector('#release-board').click()`);
    await until(() => { try { return JSON.parse(readFileSync(settings(), 'utf8')).release === true; } catch { return false; } }, 'settings.json');
    await until(async () => {
      await page.evaluate(`document.querySelector('.k95-menu')?.remove()`);
      await click('#start');
      return page.evaluate(`[...document.querySelectorAll('.k95-menu > li')].some((li) => li.textContent === 'Release board…')`);
    }, 'the Release board entry');
    await page.evaluate(`document.querySelector('.k95-menu').remove()`);
  });

  it('Start -> Release board opens a dialog with Patch, Minor and Major and their versions, Patch selected', async () => {
    lookLikeKanban95(true);
    setRelease(true);
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    await page.evaluate(`(() => {
      const real = window.fetch;
      window.fetch = (url, opts) => url === '/api/release' && !opts?.method?.match(/POST/)
        ? Promise.resolve(new Response(JSON.stringify({ version: '1.2.3', next: { patch: '1.2.4', minor: '1.3.0', major: '2.0.0' } }), { status: 200 }))
        : real(url, opts);
    })()`);
    await click('#start');
    await until(() => page.evaluate(`!!document.querySelector('.k95-menu')`), 'the Start menu');
    await menuPick('Release board…');
    await until(() => page.evaluate(`!!document.querySelector('dialog[open] .k95-release')`), 'the release dialog');
    const d = await page.evaluate(`(() => {
      const d = document.querySelector('dialog[open]');
      return {
        title: d.querySelector('.title-bar-text').textContent,
        text: d.querySelector('.k95-release p').textContent,
        options: [...d.querySelectorAll('input[type=radio]')].map((r) => [d.querySelector('label[for="' + r.id + '"]').textContent, r.checked]),
        buttons: [...d.querySelectorAll('.k95-buttons button')].map((b) => b.textContent),
      };
    })()`);
    expect(d).toEqual({
      title: 'Release board',
      text: 'Current version: 1.2.3',
      options: [['Patch (1.2.4)', true], ['Minor (1.3.0)', false], ['Major (2.0.0)', false]],
      buttons: ['Release', 'Cancel'],
    });
    await page.evaluate(`[...document.querySelectorAll('dialog[open] .k95-buttons button')].find((b) => b.textContent === 'Cancel').click()`);
    await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'the dialog closed');
  });
});
