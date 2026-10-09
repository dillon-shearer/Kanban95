// In headless Edge or Chrome against a running daemon (setup in ui.ts): the taskbar, the Start menu and desktop icons.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessions } from '../src/launcher.ts';
import { changed } from '../src/lifecycle.ts';
import { until } from './cdp.ts';
import { srv, db, page, base, ticket, statusBar, click, rightClick, menuItems, menuPick } from './ui.ts';

describe('ui-taskbar', { timeout: 60_000 }, () => {
  it('pins a compact tray at the far right of one taskbar row', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('#clock').textContent`), 'the clock');
    const m = await page.evaluate<Record<string, number>>(`(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect(), bar = document.getElementById('taskbar');
      const start = r('#start'), tray = r('#tray'), tasks = r('#tasks');
      return { gap: bar.getBoundingClientRect().right - tray.right, trayH: tray.height, startH: start.height,
        trayW: tray.width, tasksAfter: tray.left - tasks.right, overflow: bar.scrollWidth - bar.clientWidth,
        font: parseFloat(getComputedStyle(document.getElementById('agents')).fontSize) };
    })()`);
    expect(m.gap).toBeLessThanOrEqual(4);
    expect(m.tasksAfter).toBeGreaterThanOrEqual(0);
    expect(m.trayH).toBeLessThanOrEqual(m.startH);
    expect(m.trayW).toBeLessThan(300); // 98.css's .status-bar-field flex-grow stretched it across the bar
    expect(m.font).toBe(11);
    expect(m.overflow).toBe(0);
  });

  it('scrolls an overflowing taskbar with its arrows, the wheel and focus; buttons keep their width', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const wm = (js: string) => page.evaluate(`import('/wm.js').then((wm) => { ${js} })`);
    const arrowsShown = () => page.evaluate<boolean>(`!document.getElementById('tasks-right').hidden && !document.getElementById('tasks-left').hidden`);
    const shown = (id: string) => page.evaluate<boolean>(`(() => {
      const t = document.getElementById('tasks').getBoundingClientRect();
      const b = document.querySelector('#tasks [data-task="${id}"]').getBoundingClientRect();
      return b.left >= t.left - 0.5 && b.right <= t.right + 0.5;
    })()`);
    const ids = Array.from({ length: 60 }, (_, i) => `scroll-${i}`); // more than fit at any test viewport
    expect(await arrowsShown()).toBe(false);
    await wm(`${JSON.stringify(ids)}.forEach((id) => wm.open(id, { title: id }));`);
    try {
      expect(await arrowsShown()).toBe(true);
      expect(await page.evaluate<number>(`Math.min(...[...document.querySelectorAll('#tasks .task')].map((b) => b.getBoundingClientRect().width))`)).toBe(110);
      expect(await shown('scroll-59')).toBe(true); // the newest window is focused, so its button scrolled into view

      await page.evaluate(`document.getElementById('tasks').scrollLeft = 0`);
      expect(await shown('scroll-59')).toBe(false);
      for (let i = 0; i < 90 && !(await shown('scroll-59')); i++) await click('#tasks-right');
      expect(await shown('scroll-59')).toBe(true);
      await click('#tasks-left');
      expect(await shown('scroll-59')).toBe(false);

      await page.evaluate(`document.getElementById('tasks').scrollLeft = 0`);
      const { x, y } = await page.center('#tasks');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 100 });
      await until(() => page.evaluate<boolean>(`document.getElementById('tasks').scrollLeft > 0`), 'the wheel to scroll the taskbar');

      await page.evaluate(`document.getElementById('tasks').scrollLeft = 0`);
      await wm(`wm.focus('scroll-59');`);
      expect(await shown('scroll-59')).toBe(true);
    } finally {
      await wm(`${JSON.stringify(ids)}.forEach((id) => wm.close(id));`);
    }
    expect(await arrowsShown()).toBe(false);
  });

  it('task buttons: Ctrl+click selects, the bulk menu closes the selection, a plain click clears it, Shift+F10 opens the menu, drag reorders', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const ids = ['sel-0', 'sel-1', 'sel-2', 'sel-3'];
    await page.evaluate(`import('/wm.js').then((wm) => ${JSON.stringify(ids)}.forEach((id) => wm.open(id, { title: id })))`);
    const btn = (id: string) => `[data-task="${id}"]`;
    const selected = () => page.evaluate<string[]>(`[...document.querySelectorAll('#tasks .task.selected')].map((b) => b.dataset.task)`);
    const order = () => page.evaluate<string[]>(`[...document.querySelectorAll('#tasks .task')].map((b) => b.dataset.task).filter((t) => t.startsWith('sel-'))`);
    const isOpen = (id: string) => page.evaluate<boolean>(`!!document.querySelector('[data-win="${id}"]')`);

    for (const id of ids.slice(0, 3)) await click(btn(id), 2);
    expect(await selected()).toEqual(['sel-0', 'sel-1', 'sel-2']);
    expect(await page.evaluate(`getComputedStyle(document.querySelector('${btn('sel-0')}')).outlineStyle`)).toBe('dotted');
    await click(btn('sel-1'), 2); // Ctrl+click again deselects
    expect(await selected()).toEqual(['sel-0', 'sel-2']);
    await click(btn('sel-3'), 8); // Shift: the range from the last clicked button
    expect(await selected()).toEqual(['sel-1', 'sel-2', 'sel-3']);

    await click(btn('sel-3')); // plain click: clears, and minimizes the focused window as before
    expect(await selected()).toEqual([]);
    expect(await page.evaluate(`document.querySelector('[data-win="sel-3"]').hidden`)).toBe(true);
    await click(btn('sel-3'));
    expect(await page.evaluate(`document.querySelector('[data-win="sel-3"]').classList.contains('active')`)).toBe(true);

    await page.evaluate(`document.querySelector('${btn('sel-2')}').focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 });
    expect(await menuItems()).toEqual(['Restore', 'Minimize', 'Maximize', 'Close']);
    await menuPick('Maximize');
    expect(await page.evaluate(`document.querySelector('[data-win="sel-2"]').classList.contains('max')`)).toBe(true);

    const a = await page.center(btn('sel-0'));
    const b = await page.center(btn('sel-2'));
    await page.drag(a, b);
    expect(await order()).toEqual(['sel-1', 'sel-2', 'sel-0', 'sel-3']);
    expect(await page.evaluate(`document.querySelector('[data-win="sel-2"]').classList.contains('active')`)).toBe(true); // the drag's click focused nothing

    for (const id of ['sel-1', 'sel-0', 'sel-3']) await click(btn(id), 2);
    await rightClick(btn('sel-0'));
    expect(await menuItems()).toEqual(['Restore', 'Minimize', 'Close']);
    await menuPick('Close');
    for (const id of ['sel-1', 'sel-0', 'sel-3']) expect(await isOpen(id)).toBe(false);
    expect(await order()).toEqual(['sel-2']);
    await page.evaluate(`import('/wm.js').then((wm) => wm.close('sel-2'))`);
  });

  it("pins the desktop items after Start as one-click icons; each window's button is its kind's icon and a label, the title as tooltip", async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const pins = await page.evaluate<string[]>(`[...document.querySelectorAll('#pinned button')].map((b) => b.title)`);
    expect(pins).toEqual(await page.evaluate(`[...document.querySelectorAll('#icons .k95-icon')].map((e) => e.textContent)`));
    await until(() => page.evaluate(`[...document.querySelectorAll('#pinned img')].every((i) => i.complete && i.naturalWidth > 0)`), 'the pinned icons');
    const order = await page.evaluate<number[]>(`['#start', '#pinned', '#tasks'].map((s) => document.querySelector(s).getBoundingClientRect().left)`);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    await page.evaluate(`document.querySelector('[data-win="brain"] [aria-label="Close"]')?.click()`);
    await click('#pinned [data-pin="Brain"]');
    await until(() => page.evaluate(`!!document.querySelector('[data-win="brain"]')`), 'the Brain window');
    expect(await page.evaluate(`[...document.querySelectorAll('#pinned button')].map((b) => b.textContent).join('')`)).toBe('');
    const task = (id: string) => page.evaluate<{ text: string; title: string; icon: string; loaded: boolean }>(`(() => {
      const b = document.querySelector('[data-task="${id}"]'), i = b.querySelector('img');
      return { text: b.textContent, title: b.title, icon: i.getAttribute('src'), loaded: i.complete && i.naturalWidth > 0 };
    })()`);
    await until(async () => (await task('brain')).loaded, 'the Brain button icon');
    expect(await task('brain')).toEqual({ text: 'Brain', title: 'Brain', icon: 'icons/brain.svg', loaded: true });
    expect((await task('board')).icon).toBe('icons/board.svg');
    await page.evaluate(`document.querySelector('[data-win="brain"] [aria-label="Close"]').click()`);
  });

  it('labels a terminal by ticket and phase, or Brainstorm, keeps "(ended)" on it, and cuts a long label with an ellipsis', async () => {
    const id = ticket('Label me');
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const cookie = { cookie: `k95=${srv.secret}` };
    const label = (wid: string) => page.evaluate<string>(`document.querySelector('[data-task="${wid}"] span').textContent`);
    const launched = async (res: Response, what: string) => {
      expect(res.status).toBeLessThan(300);
      const s = await until(async () => (await (await fetch(`${base}api/sessions`, { headers: cookie })).json())
        .find((x: { ticket_id: number | null; role: string }) => (what === 'ticket' ? x.ticket_id === id : x.ticket_id === null && x.role !== 'operator')), `the ${what} session`);
      await until(() => page.evaluate(`!!document.querySelector('[data-task="term-${s.id}"]')`), `the ${what} terminal`);
      return { wid: `term-${s.id}`, grant: s.grant_id as number };
    };

    const { wid: term, grant } = await launched(await fetch(`${base}api/tickets/${id}/launch`, { method: 'POST', headers: cookie }), 'ticket');
    expect(await label(term)).toBe(`#${id} execute`);
    await fetch(`${base}api/grants/${grant}`, { method: 'DELETE', headers: cookie });
    await until(async () => (await label(term)) === `#${id} execute (ended)`, 'the ended label');
    db.prepare("UPDATE tickets SET status = 'done', merged_at = 'x' WHERE id = ?").run(id);

    const bs = await launched(await fetch(`${base}api/brainstorm`, { method: 'POST', headers: { ...cookie, 'content-type': 'application/json' }, body: '{}' }), 'brainstorm');
    expect(await label(bs.wid)).toBe('Brainstorm');
    await fetch(`${base}api/grants/${bs.grant}`, { method: 'DELETE', headers: cookie });

    await page.evaluate(`import('/wm.js').then((wm) => wm.open('long', { title: 'A window whose label is far too long for its button' }))`);
    const m = await page.evaluate<{ w: number; cut: boolean }>(`(() => {
      const b = document.querySelector('[data-task="long"]'), s = b.querySelector('span');
      return { w: b.getBoundingClientRect().width, cut: s.scrollWidth > s.clientWidth && getComputedStyle(s).textOverflow === 'ellipsis' };
    })()`);
    expect(m).toEqual({ w: 110, cut: true });
    await page.evaluate(`import('/wm.js').then((wm) => wm.close('long'))`);
    await until(() => sessions.size === 0, 'the agents to exit');
  });

  it('opens Settings from a double-clicked desktop icon and Inbox from Enter; icons stay under windows', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    expect(await page.evaluate(`[...document.querySelectorAll('#icons .k95-icon')].map((e) => e.textContent)`))
      .toEqual(['Board', 'Inbox', 'Brain', 'Settings', 'Notepad', 'Limits', 'New ticket', 'New brainstorm']);
    await page.evaluate(`document.querySelector('[data-win="board"] [aria-label="Close"]').click()`); // the board may sit over the icons
    // Every image loaded from our origin: a CSP block or a missing file leaves naturalWidth at 0.
    await until(() => page.evaluate(`[...document.querySelectorAll('#icons img')].every((i) => i.complete && i.naturalWidth === 32)`), 'the icon images');

    const { x, y } = await page.center('[data-icon="Settings"]');
    expect(await page.evaluate(`document.elementFromPoint(${x}, ${y}).closest('.k95-icon')?.dataset.icon ?? null`)).toBe('Settings');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    expect(await page.evaluate(`document.activeElement.dataset.icon`)).toBe('Settings');
    expect(await page.evaluate(`getComputedStyle(document.activeElement.querySelector('span')).backgroundColor`)).toBe('rgb(0, 0, 128)');
    expect(await page.evaluate(`!!document.querySelector('[data-win="settings"]')`)).toBe(false); // one click only selects
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
    await until(() => page.evaluate(`!!document.querySelector('[data-win="settings"]')`), 'the Settings window');

    await page.evaluate(`document.querySelector('[data-icon="Inbox"]').focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(() => page.evaluate(`!!document.querySelector('[data-win="inbox"]')`), 'the Inbox window');

    // A window dragged over the icons covers them.
    await page.evaluate(`Object.assign(document.querySelector('[data-win="settings"]').style, { left: '0px', top: '0px' })`);
    const s = await page.center('[data-icon="Board"]');
    expect(await page.evaluate(`!!document.elementFromPoint(${s.x}, ${s.y}).closest('[data-win]')`)).toBe(true);
  });

  it('Start → Restart board confirms with the agent count and the shell caveat, and shows a failed build in a dialog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'k95-root-'));
    mkdirSync(join(root, 'daemon', 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: `node -e "console.log('error TS2322: nope'); process.exit(2)"` } }));
    let shutdowns = 0;
    Object.assign(srv.board, { root, shutdown: () => shutdowns++ });
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const dialog = (title: string) => page.evaluate<string | null>(`[...document.querySelectorAll('dialog[open]')].find((d) => d.querySelector('.title-bar-text').textContent === '${title}')?.querySelector('.window-body').textContent ?? null`);
    const press = (button: string) => page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === '${button}').click()`);

    await click('#start');
    await page.evaluate(`[...document.querySelectorAll('.k95-menu li')].find((li) => li.textContent === 'Restart board').click()`);
    await until(() => dialog('Restart board'), 'the confirm');
    const text = (await dialog('Restart board'))!;
    const agents = [...sessions.values()].filter((s) => s.ticketId !== null).length; // earlier tests may leave some running
    expect(text).toContain(agents ? `${agents} agent${agents === 1 ? ' is' : 's are'} running; they are resumed after the restart.` : 'No agents are running.');
    expect(text).toContain('Shell changes need a full relaunch');
    await press('Restart');
    await until(() => dialog('Board not restarted'), 'the build error', 30_000);
    expect(await dialog('Board not restarted')).toContain('error TS2322: nope');
    await press('OK');
    expect(await statusBar()).toBe('Board not restarted: see the dialog');
    expect(shutdowns).toBe(0);
    Object.assign(srv.board, { root: undefined, shutdown: undefined });
    rmSync(root, { recursive: true, force: true });
  });

  it('a stale daemon: the status bar says restart, the tray shows a Restart badge that opens the Restart board confirm', async () => {
    await page.goto(base);
    await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
    const badge = () => page.evaluate<boolean>(`!document.getElementById('restart-badge').hidden`);
    const bar = () => page.evaluate<string>(`document.querySelector('.k95-board .status-bar').textContent`);
    const dialog = () => page.evaluate<string | null>(`[...document.querySelectorAll('dialog[open]')].find((d) => d.querySelector('.title-bar-text').textContent === 'Restart board')?.querySelector('.window-body').textContent ?? null`);
    expect(await badge()).toBe(false);
    expect(await bar()).not.toContain('Restart the board');
    try {
      for (const stale of ['daemon', 'shell'] as const) {
        srv.board.stale = stale;
        changed(null);
        await until(badge, 'the Restart badge');
        expect(await bar()).toContain('Restart the board to use the merged changes.');
        await click('#restart-badge');
        await until(dialog, 'the confirm');
        expect((await dialog())!.includes('A merge changed the shell itself')).toBe(stale === 'shell');
        await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Cancel').click()`);
        srv.board.stale = false; // a restart clears it; the next round then waits on a fresh refetch
        changed(null);
        await until(async () => !(await badge()), 'the badge to go');
      }
    } finally {
      srv.board.stale = false;
    }
  });
});
