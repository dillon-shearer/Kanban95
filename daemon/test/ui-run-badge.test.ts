// In headless Edge or Chrome against a running daemon (setup in ui.ts): a running card's badge shows its phase and elapsed time.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { srv, page, base, ticket, column } from './ui.ts';

describe('ui-run-badge', { timeout: 60_000 }, () => {
  it('shows the phase and minutes on a launched card in the run badge, and nothing on an idle card or the taskbar tray', async () => {
    const id = ticket('Badge me');
    const idle = ticket('Idle');
    await page.goto(base);
    await until(() => column(id), 'the card');
    const runs = (n: number) => page.evaluate<string[]>(`[...document.querySelectorAll('.card[data-id="${n}"] .badge.run')].map((b) => b.className + ':' + b.textContent)`);
    const tray = () => page.evaluate<string>(`document.querySelector('#tray').textContent + ' ' + document.querySelector('.k95-board .status-bar').textContent`);
    expect(await runs(id)).toEqual([]);

    const cookie = { cookie: `k95=${srv.secret}` };
    expect((await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: cookie })).status).toBe(200);
    await until(async () => (await runs(id)).length === 1, 'the run badge');
    expect(await runs(id)).toEqual(['badge run:execute 0m']);
    expect(await runs(idle)).toEqual([]);
    expect(await page.evaluate(`document.querySelectorAll('.card[data-id="${idle}"] .badge').length`)).toBe(3);
    expect(await tray()).not.toMatch(/execute|\d+m\b/);

    expect((await fetch(`${base}api/tickets/${id}`, { method: 'PATCH', headers: { ...cookie, 'content-type': 'application/json' }, body: '{"status":"backlog"}' })).status).toBe(200);
    await until(async () => (await runs(id)).length === 0, 'the badge gone');
    await until(() => sessions.size === 0, 'the agent to exit');
  });
});
