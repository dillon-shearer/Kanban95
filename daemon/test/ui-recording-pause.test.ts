import './home.ts';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { events } from '../src/lifecycle.ts';
import { until } from './cdp.ts';
import { base, click, page } from './ui.ts';

const settingsFile = () => join(process.env.KANBAN95_HOME!, 'settings.json');
const idle = { state: 'idle', mode: 'regular', started: null as string | null, elapsed: 0, speed: 10, progress: null, output: null, error: null, fastStretches: 0 };
const frame = (r: Partial<typeof idle>) => events.emit('event', { recording: { ...idle, ...r } });
const tray = () => page.evaluate<{ rec: { text: string; live: boolean; paused: boolean; title: string }; mode: { text: string; disabled: boolean; stop: boolean; title: string } }>(`(() => {
  const r = document.getElementById('rec'), m = document.getElementById('rec-mode');
  return { rec: { text: r.textContent, live: r.classList.contains('live'), paused: r.classList.contains('paused'), title: r.title },
    mode: { text: m.textContent, disabled: m.disabled, stop: m.classList.contains('stop'), title: m.title } };
})()`);
const field = () => page.evaluate<string | null>(`(() => { const f = document.querySelector('.k95-board .k95-recording'); return f && !f.hidden ? f.textContent : null; })()`);
const posts = () => page.evaluate<string[]>('window.__posts');
const open = async () => {
  writeFileSync(settingsFile(), JSON.stringify({ recording: { enabled: true } }));
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await page.evaluate(`(() => {
    window.__posts = [];
    const real = window.fetch;
    window.fetch = (url, init = {}) => {
      if (init.method === 'POST' && /\\/api\\/recording\\//.test(url)) { window.__posts.push(url); return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(idle)}), { status: 200 })); }
      return real(url, init);
    };
  })()`);
};
const show = (r: Partial<typeof idle>, ready: (t: Awaited<ReturnType<typeof tray>>) => boolean) => until(async () => {
  frame(r);
  return ready(await tray());
}, `the ${r.state} frame`);
const paused = { state: 'paused', elapsed: 754, started: null, fastStretches: 1 };
const keys = (key: string) => page.evaluate(`dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: true, shiftKey: true, bubbles: true }))`);

describe('ui-recording-pause', { timeout: 60_000 }, () => {
  afterEach(() => {
    frame({});
    rmSync(settingsFile(), { force: true });
  });

  it('a paused frame shows the frozen time with an amber dot, Stop in the speed slot and the paused status line', async () => {
    await open();
    await show(paused, (t) => t.rec.paused);
    const t = await tray();
    expect(t.rec).toMatchObject({ text: '12:34', live: false, paused: true, title: 'Resume recording' });
    expect(t.mode).toMatchObject({ text: '■Stop', disabled: false, stop: true, title: 'Stop and render' });
    expect(await field()).toBe('Paused 12:34 · fast stretches so far: 1');
  });

  it('a recording frame adds the running part to elapsed and puts the speed button back', async () => {
    await open();
    await show(paused, (t) => t.mode.stop);
    await show({ state: 'recording', elapsed: 60, started: new Date(Date.now() - 15_000).toISOString() }, (t) => t.rec.live);
    const t = await tray();
    expect(t.rec.text).toMatch(/^1:1[5-7]$/);
    expect(t.rec).toMatchObject({ paused: false, title: 'Pause recording' });
    expect(t.mode).toMatchObject({ text: '▶1x', stop: false, title: 'Regular speed. Click for fast' });
  });

  it('Rec pauses while recording and resumes while paused', async () => {
    await open();
    await show({ state: 'recording', started: new Date().toISOString() }, (t) => t.rec.live);
    await click('#rec');
    await until(async () => (await posts()).length === 1, 'the pause post');
    expect(await posts()).toEqual(['/api/recording/pause']);

    await show(paused, (t) => t.rec.paused);
    await click('#rec');
    await until(async () => (await posts()).length === 2, 'the resume post');
    expect((await posts())[1]).toBe('/api/recording/resume');
  });

  it('Stop while paused asks first: Cancel sends nothing, OK posts stop', async () => {
    await open();
    await show(paused, (t) => t.mode.stop);
    const ask = async () => {
      await click('#rec-mode');
      return until(() => page.evaluate<string | null>(`document.querySelector('dialog[open] .title-bar-text')?.textContent ?? null`), 'the confirm');
    };
    const press = (label: string) => page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === '${label}').click()`);
    expect(await ask()).toBe('Stop recording');
    expect(await page.evaluate(`document.querySelector('dialog[open] .window-body').textContent.startsWith('Stop and render?')`)).toBe(true);
    await press('Cancel');
    await until(() => page.evaluate(`!document.querySelector('dialog[open]')`), 'the confirm to close');
    expect(await posts()).toEqual([]);

    await ask();
    await press('OK');
    await until(async () => (await posts()).length === 1, 'the stop post');
    expect(await posts()).toEqual(['/api/recording/stop']);
  });

  it('Ctrl+Shift+Space switches speed while recording and sends nothing while paused', async () => {
    await open();
    await show(paused, (t) => t.rec.paused);
    await keys(' ');
    await keys('R');
    await until(async () => (await posts()).length === 1, 'the resume post');
    expect(await posts()).toEqual(['/api/recording/resume']);

    await show({ state: 'recording', started: new Date().toISOString() }, (t) => t.rec.live);
    await keys(' ');
    await until(async () => (await posts()).length === 2, 'the mode post');
    expect((await posts())[1]).toBe('/api/recording/mode');
  });
});
