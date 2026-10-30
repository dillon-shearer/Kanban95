import './home.ts';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { events } from '../src/lifecycle.ts';
import { until } from './cdp.ts';
import { base, page } from './ui.ts';

const settingsFile = () => join(process.env.KANBAN95_HOME!, 'settings.json');
const idle = { state: 'idle', mode: 'regular', started: null, elapsed: 0, speed: 10, progress: null, output: null, error: null, fastStretches: 0 };
const frame = (r: Partial<typeof idle> | Record<string, unknown>) => events.emit('event', { recording: { ...idle, ...r } });
const tray = () => page.evaluate<{ rec: { hidden: boolean; disabled: boolean; text: string; live: boolean }; mode: { hidden: boolean; disabled: boolean; text: string; bg: string } }>(`(() => {
  const r = document.getElementById('rec'), m = document.getElementById('rec-mode');
  return { rec: { hidden: r.hidden, disabled: r.disabled, text: r.textContent, live: r.classList.contains('live') },
    mode: { hidden: m.hidden, disabled: m.disabled, text: m.textContent, bg: getComputedStyle(m).backgroundColor } };
})()`);
const field = () => page.evaluate<string | null>(`(() => { const f = document.querySelector('.k95-board .k95-recording'); return f && !f.hidden ? f.textContent : null; })()`);
const open = async (enabled: boolean) => {
  writeFileSync(settingsFile(), JSON.stringify({ recording: { enabled } }));
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
};

describe('ui-recording', { timeout: 60_000 }, () => {
  afterEach(() => {
    frame({});
    rmSync(settingsFile(), { force: true });
  });

  it('with recording off the Rec and speed buttons are hidden', async () => {
    await open(false);
    const t = await tray();
    expect(t.rec.hidden).toBe(true);
    expect(t.mode.hidden).toBe(true);
  });

  it('with recording on they show left of Inbox: idle Rec, a disabled grey 1x, no status line', async () => {
    await open(true);
    const t = await tray();
    expect(t.rec).toMatchObject({ hidden: false, disabled: false, text: 'Rec', live: false });
    expect(t.mode).toMatchObject({ hidden: false, disabled: true, text: '▶1x' });
    expect(await page.evaluate(`document.getElementById('rec-mode').nextElementSibling.id`)).toBe('inbox-count');
    expect(await field()).toBeNull();
  });

  it('a fast recording frame turns the speed button blue with 10x and Rec shows the time; regular is green 1x', async () => {
    await open(true);
    const started = new Date(Date.now() - 75_000).toISOString();
    await until(async () => {
      frame({ state: 'recording', mode: 'fast', started, fastStretches: 1 });
      return (await tray()).mode.text.endsWith('10x');
    }, 'the fast frame');
    let t = await tray();
    expect(t.mode).toMatchObject({ disabled: false, bg: 'rgb(0, 0, 170)' });
    expect(t.rec.live).toBe(true);
    expect(t.rec.text).toMatch(/^1:1\d$/);
    expect(await field()).toMatch(/^Recording 1:1\d, fast 10x · fast stretches so far: 1$/);

    await until(async () => {
      frame({ state: 'recording', mode: 'regular', started, fastStretches: 1 });
      return (await tray()).mode.text === '▶1x';
    }, 'the regular frame');
    t = await tray();
    expect(t.mode.bg).toBe('rgb(0, 170, 0)');
    expect(await field()).toMatch(/^Recording 1:1\d, regular/);
  });

  it('a rendering frame disables Rec with Rendering in its text; a failed render shows Rec again and the error', async () => {
    await open(true);
    await until(async () => {
      frame({ state: 'rendering', mode: 'fast', progress: 0.4 });
      return (await tray()).rec.disabled;
    }, 'the rendering frame');
    const t = await tray();
    expect(t.rec.text).toBe('Rendering 40%');
    expect(t.mode.disabled).toBe(true);
    expect(await field()).toBe('Rendering 40%');

    await until(async () => {
      frame({ error: 'ffmpeg exited with code 1' });
      return (await tray()).rec.text === 'Rec' && (await field()) !== null;
    }, 'Rec again');
    expect((await tray()).rec.disabled).toBe(false);
    expect(await field()).toBe('ffmpeg exited with code 1');
  });
});
