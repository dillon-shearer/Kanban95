// In headless Edge or Chrome against a running daemon (setup in ui.ts): Settings → Projects, the wallpaper colour and the title.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { boards, entryPath } from '../src/boards.ts';
import { writeProjects } from '../src/settings.ts';
import { page, base, repo, srv, statusBar } from './ui.ts';

const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'k95-other-'))); // a plain folder, no git
afterAll(() => rmSync(other, { recursive: true, force: true, maxRetries: 5 }));

const saved = () => JSON.parse(readFileSync(join(process.env.USERPROFILE!, '.kanban95', 'projects.json'), 'utf8'));
const wall = () => page.evaluate<string>(`getComputedStyle(document.body).backgroundColor`);
const board = () => until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
const row = (path: string) => `[data-win="settings"] tr[data-project="${path.replaceAll('\\', '\\\\')}"]`;
const add = (path: string) => page.evaluate(`(() => { document.querySelector('#project-add').value = ${JSON.stringify(path)};
  [...document.querySelectorAll('[data-win="settings"] button')].find((b) => b.textContent === 'Add').click(); })()`);
const colour = (path: string, hex: string) => page.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(`${row(path)} input[type=color]`)});
  i.value = ${JSON.stringify(hex)}; i.dispatchEvent(new Event('change')); })()`);
const remove = (path: string) => page.evaluate(`document.querySelector(${JSON.stringify(`${row(path)} button`)}).click()`);
const openProjects = async () => {
  await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await page.evaluate(`[...document.querySelectorAll('[data-win="settings"] [role=tab] a')].find((t) => t.textContent === 'Projects').click()`);
  await until(() => page.evaluate(`!!document.querySelector('#project-add')`), 'the Projects tab');
};

describe('ui-projects', { timeout: 60_000 }, () => {
  it('titles the page after the repo folder and paints the default teal', async () => {
    await page.goto(base);
    await board();
    const name = basename(realpathSync.native(repo));
    await until(async () => (await page.evaluate<string>('document.title')) === `${name} — Kanban95`, 'the title');
    expect(await wall()).toBe('rgb(0, 128, 128)');
  });

  it('adds a plain folder, recolours and removes it, refuses a missing folder and its own removal, and repaints the wallpaper', async () => {
    const own = realpathSync.native(repo);
    await page.goto(base);
    await board();
    await openProjects();
    expect(saved()).toEqual([{ path: own, colour: '#008080' }]);
    expect(await page.evaluate(`document.querySelector(${JSON.stringify(`${row(own)} button`)}).disabled`)).toBe(true);

    await add(join(other, 'missing'));
    await until(async () => (await statusBar()).includes('is not a folder'), 'the refusal in the status bar');
    expect(saved()).toHaveLength(1);

    await add(other);
    await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(row(other))})`), 'the added row');
    expect(saved()).toEqual([{ path: own, colour: '#008080' }, { path: other, colour: '#008080' }]);
    await colour(other, '#ff0000');
    await until(() => saved()[1].colour === '#ff0000', 'the other colour saved');
    expect(await wall()).toBe('rgb(0, 128, 128)'); // another board's colour leaves this wallpaper alone
    await remove(other);
    // The panel redraws after the reply; a change made before that would save the old list and bring the row back.
    await until(async () => saved().length === 1 && !(await page.evaluate(`!!document.querySelector(${JSON.stringify(row(other))})`)), 'the removal saved and redrawn');

    await colour(own, '#123456');
    await until(async () => (await wall()) === 'rgb(18, 52, 86)', 'the wallpaper repainted without a reload');
    expect(saved()).toEqual([{ path: own, colour: '#123456' }]);
    await page.goto(base);
    await board();
    await until(async () => (await wall()) === 'rgb(18, 52, 86)', 'the colour kept after a reload');
  });

  it('Start → Projects lists every project, marks the running one, greys out its own, and opens or focuses on a click', async () => {
    const own = realpathSync.native(repo);
    const idle = realpathSync.native(mkdtempSync(join(tmpdir(), 'k95-idle-')));
    execFileSync('git', ['init', '-q'], { cwd: idle });
    const root = mkdtempSync(join(tmpdir(), 'k95-root-')); // a checkout with a built shell; nothing is really started
    for (const f of ['daemon/src/server.ts', 'shell/target/debug/kanban95-shell.exe', 'Kanban95.command']) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), '');
    }
    const started: string[][] = [];
    boards.start = async (cmd, args) => void started.push([cmd, ...args]);
    srv.board.root = root;
    writeProjects([{ path: own, colour: '#008080' }, { path: other, colour: 200 }, { path: idle, colour: 300 }], own);
    writeFileSync(entryPath(process.ppid), JSON.stringify({ pid: process.ppid, repo: other, port: 1, started: '' })); // a live pid serving `other`
    const projects = () => page.evaluate<[string, boolean][]>(`[...[...document.querySelectorAll('.k95-menu > li.sub')]
      .find((li) => li.firstChild.textContent === 'Projects').querySelectorAll('li')].map((li) => [li.textContent, li.hasAttribute('aria-disabled')])`);
    const pick = (label: string) => page.evaluate(`[...document.querySelectorAll('.k95-menu li.sub li')].find((li) => li.textContent === ${JSON.stringify(label)}).click()`);
    try {
      await page.goto(base); // the list is read at boot
      await board();
      const want = [[`${basename(own)} (this board)`, true], [`${basename(other)} (running)`, false], [basename(idle), false]];
      await until(async () => {
        await page.evaluate(`document.getElementById('start').click()`);
        return JSON.stringify(await projects()) === JSON.stringify(want);
      }, 'the Projects submenu');

      await pick(`${basename(own)} (this board)`); // disabled: nothing happens
      await pick(basename(idle));
      await until(async () => (await statusBar()) === `Opening ${basename(idle)}…`, 'the opening status');
      await until(() => started.length === 1, 'the start');
      expect(started[0].at(-1)).toBe(idle);

      await page.evaluate(`document.getElementById('start').click()`);
      await pick(`${basename(other)} (running)`); // no window has that title here, so it is not found
      await until(async () => (await statusBar()) === `${basename(other)} is running: switch to its window.`, 'the focus status');
      expect(started).toHaveLength(1);
    } finally {
      rmSync(entryPath(process.ppid), { force: true });
      srv.board.root = undefined;
      for (const d of [idle, root]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
