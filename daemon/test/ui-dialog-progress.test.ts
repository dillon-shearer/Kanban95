// In headless Edge or Chrome against a running daemon (setup in ui.ts): a buttonless progress dialog opens, focuses itself and closes cleanly.
import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base } from './ui.ts';

describe('ui-dialog-progress', { timeout: 60_000 }, () => {
  it('opens a dialog with no controls, focuses it, and resolves null with the node removed on close', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const r = await page.evaluate<{ error: string | null; focused: boolean; open: number; result: unknown; left: number }>(`(async () => {
      const { dialog, h } = await import('/wm.js');
      let error = null;
      let p;
      try { p = dialog('Working', h('div', {}, h('p', {}, 'please wait')), []); } catch (e) { error = String(e); }
      p?.catch((e) => { error = String(e); });
      await new Promise((ok) => setTimeout(ok, 50));
      const d = document.querySelector('dialog[open]');
      const focused = !!d && document.activeElement === d;
      const open = document.querySelectorAll('dialog[open]').length;
      d?.close();
      const result = await p;
      return { error, focused, open, result, left: document.querySelectorAll('dialog').length };
    })()`);
    expect(r).toEqual({ error: null, focused: true, open: 1, result: null, left: 0 });
  });

  it('lets ensureModel return true once the first download completes', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const r = await page.evaluate<{ ok: unknown; dialogs: number; downloads: number }>(`(async () => {
      const real = window.fetch;
      let downloads = 0;
      let finish;
      const done = new Promise((ok) => { finish = ok; });
      const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
      window.fetch = async (url, opts) => {
        if (url === '/api/voice/download') { downloads++; await done; return json({ ok: true }); }
        if (url === '/api/voice') return json({ downloaded: false, id: 'm', source: 'https://example.invalid/m', revision: 'r', size: 1000, license: 'MIT', files: [], received: null });
        return real(url, opts);
      };
      try {
        const { ensureModel } = await import('/voice.js');
        const pending = ensureModel();
        for (let i = 0; i < 100 && !document.querySelector('dialog[open] button'); i++) await new Promise((ok) => setTimeout(ok, 20));
        [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Download').click();
        for (let i = 0; i < 100 && downloads === 0; i++) await new Promise((ok) => setTimeout(ok, 20));
        finish();
        const ok = await Promise.race([pending, new Promise((ok) => setTimeout(() => ok('timeout'), 5000))]);
        return { ok, dialogs: document.querySelectorAll('dialog').length, downloads };
      } finally { window.fetch = real; }
    })()`);
    expect(r).toEqual({ ok: true, dialogs: 0, downloads: 1 });
  });
});
