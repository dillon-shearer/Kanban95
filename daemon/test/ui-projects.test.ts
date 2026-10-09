// In headless Edge or Chrome against a running daemon (setup in ui.ts): Settings → Projects, the wallpaper colour and the title.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { until } from './cdp.ts';
import { page, base, repo, statusBar } from './ui.ts';

const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'k95-other-')));
execFileSync('git', ['init', '-q'], { cwd: other });
const plain = mkdtempSync(join(tmpdir(), 'k95-plain-'));
afterAll(() => {
  for (const d of [other, plain]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

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

  it('adds, recolours and removes a project, refuses a non-repo and its own removal, and repaints the wallpaper', async () => {
    const own = realpathSync.native(repo);
    await page.goto(base);
    await board();
    await openProjects();
    expect(saved()).toEqual([{ path: own, colour: '#008080' }]);
    expect(await page.evaluate(`document.querySelector(${JSON.stringify(`${row(own)} button`)}).disabled`)).toBe(true);

    await add(plain);
    await until(async () => (await statusBar()).includes('not a git repo'), 'the refusal in the status bar');
    expect(saved()).toHaveLength(1);

    await add(other);
    await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(row(other))})`), 'the added row');
    expect(saved()).toEqual([{ path: own, colour: '#008080' }, { path: other, colour: '#008080' }]);
    await colour(other, '#ff0000');
    await until(() => saved()[1].colour === '#ff0000', 'the other colour saved');
    expect(await wall()).toBe('rgb(0, 128, 128)'); // another board's colour leaves this wallpaper alone
    await remove(other);
    await until(() => saved().length === 1, 'the removal saved');

    await colour(own, '#123456');
    await until(async () => (await wall()) === 'rgb(18, 52, 86)', 'the wallpaper repainted without a reload');
    expect(saved()).toEqual([{ path: own, colour: '#123456' }]);
    await page.goto(base);
    await board();
    await until(async () => (await wall()) === 'rgb(18, 52, 86)', 'the colour kept after a reload');
  });
});
