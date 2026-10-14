import './home.ts';
import { describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base } from './ui.ts';

const blocked = async (userAgent: string) => {
  await page.send('Emulation.setUserAgentOverride', { userAgent });
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('.k95-mic')`), 'a mic button');
  await page.evaluate(`(() => {
    const real = window.fetch;
    window.fetch = (u, o) => String(u).endsWith('/api/voice') ? Promise.resolve(new Response('{"downloaded":true}')) : real(u, o);
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    document.querySelector('.k95-mic').dispatchEvent(new PointerEvent('pointerdown'));
  })()`);
  const sel = `dialog[aria-label="Microphone unavailable"]`;
  await until(() => page.evaluate(`!!document.querySelector('${sel}')`), 'the mic blocked dialog');
  const text = await page.evaluate<string>(`document.querySelector('${sel} .window-body').textContent`);
  await page.evaluate(`document.querySelector('${sel}').close()`);
  return text;
};

describe('ui-mic-blocked', { timeout: 60_000 }, () => {
  it('names System Settings and Kanban95 on macOS, with no Windows steps', async () => {
    const text = await blocked('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)');
    expect(text).toContain('Kanban95 is not allowed to use the microphone.');
    expect(text).toContain('System Settings → Privacy & Security → Microphone, turn Kanban95 on, then restart the app.');
    expect(text).not.toContain('Windows');
  });

  it('keeps the Windows steps on Windows', async () => {
    const text = await blocked('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/130.0.0.0');
    expect(text).toBe('Kanban95 is not allowed to use the microphone.'
      + 'Windows: open Privacy & security → Microphone in the Windows Settings app. Turn on "Microphone access" and "Let desktop apps access your microphone", then try again.'
      + 'Windows dictation (Win+H) also works in any field.'
      + 'OK');
  });
});
