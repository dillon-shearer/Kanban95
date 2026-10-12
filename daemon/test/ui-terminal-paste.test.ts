import './home.ts';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, page, base, ticket, column } from './ui.ts';

describe('ui-terminal-paste', { timeout: 60_000 }, () => {
  it('a paste over 64 KiB reaches the agent whole, in frames under the limit, and the terminal stays open', async () => {
    const id = ticket('Paste');
    await page.goto(base);
    await until(() => column(id), 'the card');
    const cookie = { cookie: `k95=${srv.secret}` };
    expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: cookie })).status).toBe(200);
    const s = await until(() => [...sessions.values()].find((x) => x.ticketId === id), 'the session');
    const wid = `term-${s.key}`;
    await until(() => page.evaluate(`!!document.querySelector('[data-win="${wid}"] .xterm')`), 'the terminal');
    const writes: string[] = [];
    const write = s.pty.write.bind(s.pty);
    s.pty.write = (d: string) => { writes.push(d); };
    const text = ('\x01é\u{1F600}a').repeat(20_000);
    try {
      await page.evaluate(`(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', ${JSON.stringify(text)});
        document.querySelector('[data-win="${wid}"] .xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      })()`);
      await until(() => writes.join('').length >= text.length, 'the whole paste');
      expect(writes.join('')).toBe(text);
      expect(writes.length).toBeGreaterThan(1);
      expect(Math.max(...writes.map((w) => Buffer.byteLength(JSON.stringify({ data: w }))))).toBeLessThanOrEqual(1 << 16);
      expect(await page.evaluate(`document.querySelector('[data-win="${wid}"]').classList.contains('ended')`)).toBe(false);
    } finally {
      s.pty.write = write;
    }
  });
});
