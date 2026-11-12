import './home.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { worktreePath } from '../src/git.ts';
import { sessions } from '../src/launcher.ts';
import { until } from './cdp.ts';
import { base, column, git, page, repo, srv, ticket } from './ui.ts';

describe('ui-setup-terminal', { timeout: 60_000 }, () => {
  it('opens the ticket terminal while its worktree_setup runs, and the agent follows in that same window', async () => {
    writeFileSync(join(repo, 'setup.mjs'), `import { existsSync } from 'node:fs';
console.log('setup step one');
while (!existsSync('go')) await new Promise((r) => setTimeout(r, 25));
`);
    git('add', 'setup.mjs');
    git('commit', '-qm', 'Add setup script');
    writeFileSync(join(repo, '.kanban95', 'config.json'), JSON.stringify({ worktree_setup: 'node setup.mjs' }));
    const id = ticket('Terminal at launch');
    const api = (path: string, method = 'GET') => fetch(`${base}api${path}`, { method, headers: { cookie: `k95=${srv.secret}` } });
    await page.goto(base);
    await until(() => column(id), 'the card');

    expect((await api(`/tickets/${id}/launch`, 'POST')).status).toBe(200);
    const sel = `[data-win^="term-setup-${id}-"]`;
    await until(() => page.evaluate(`!!document.querySelector('${sel} .xterm')`), 'the terminal during setup');
    expect((await (await api('/runner')).json()).setup.map((s: { ticket_id: number }) => s.ticket_id)).toEqual([id]);
    expect(await page.evaluate<string>(`document.querySelector('${sel} .title-bar-text').textContent`)).toBe(`#${id} — execute — setup`);
    await until(() => page.evaluate(`document.querySelector('${sel} .xterm-rows')?.textContent.includes('setup step one')`), 'the setup output in the window');

    writeFileSync(join(worktreePath(repo, id), 'go'), '');
    await until(() => page.evaluate(`document.querySelector('${sel} .xterm-rows')?.textContent.includes('FAKE work')`), 'the agent output in the same window');
    expect(await page.evaluate<string>(`document.querySelector('${sel} .title-bar-text').textContent`)).toBe(`#${id} — execute — work`);
    const [x, y] = await page.evaluate<number[]>(`(() => { const r = document.querySelector('${sel} .xterm-screen').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -5000 });
    await until(() => page.evaluate(`document.querySelector('${sel} .xterm-rows').textContent.includes('setup step one')`), 'the setup output in the scrollback above the agent');
    expect(await page.evaluate<number>(`document.querySelectorAll('[data-win^="term-"]').length`)).toBe(1);
    expect(await page.evaluate<boolean>(`document.querySelector('${sel}').classList.contains('ended')`)).toBe(false);
    await until(() => [...sessions.values()].every((s) => s.scrollback().includes('FAKE')), 'the agent to print');
  });
});
