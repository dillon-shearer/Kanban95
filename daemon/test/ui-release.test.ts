// In headless Edge or Chrome against a running daemon (setup in ui.ts): the release-pending text and Start -> Release board.
import './home.ts';
import { describe, expect, it } from 'vitest';
import { changed } from '../src/lifecycle.ts';
import { until } from './cdp.ts';
import { srv, page, base, click, menuPick } from './ui.ts';

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

  it('Start -> Release board opens a dialog with Patch, Minor and Major and their versions, Patch selected', async () => {
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
