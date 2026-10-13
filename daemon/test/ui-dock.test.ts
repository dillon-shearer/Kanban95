import './home.ts';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { entryPath, register } from '../src/boards.ts';
import { until } from './cdp.ts';
import { base, click, page, repo, srv } from './ui.ts';

let entry: { repo: string; port: number; shell: number | null };
const lines: string[] = [];
const write = process.stdout.write.bind(process.stdout);

beforeAll(() => {
  srv.board.shellId = 123;
  srv.board.shell = true;
  entry = JSON.parse(readFileSync(entryPath(process.pid), 'utf8'));
  register(entry.repo, entry.port, 123);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...rest) => {
    if (!String(chunk).startsWith('KANBAN95 ')) return write(chunk, ...(rest as []));
    lines.push(String(chunk));
    return true;
  });
});
afterAll(() => {
  vi.restoreAllMocks();
  register(entry.repo, entry.port, entry.shell);
  srv.board.shellId = null;
  srv.board.shell = false;
});

const ownMenu = async (url: string) => {
  await page.goto('about:blank');
  await page.goto(url);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await click('#start');
  const items = () => page.evaluate<string[] | null>(`(() => { const li = [...document.querySelectorAll('.k95-menu li.sub')]
    .find((li) => li.firstChild.textContent === ${JSON.stringify(`${basename(repo)} (this board)`)});
    return li ? [...li.querySelector('ul').children].map((x) => x.textContent) : null; })()`);
  await until(async () => !!(await items()), 'this board in Start → Projects');
  return (await items())!;
};

describe('ui-dock', { timeout: 60_000 }, () => {
  it('offers Dock only in a popped-out window, and Dock posts /projects/dock and tells the shell', async () => {
    expect(await ownMenu(base)).not.toContain('Dock');
    expect(await ownMenu(`${base}#own`)).toContain('Dock');
    await page.evaluate(`(() => { window.posts = []; const f = window.fetch;
      window.fetch = (u, o) => { if (o?.method === 'POST') window.posts.push([u, JSON.parse(o.body)]); return f(u, o); }; })()`);
    await page.evaluate(`[...document.querySelectorAll('.k95-menu li')].find((li) => li.textContent === 'Dock').click()`);
    await until(async () => (await page.evaluate<unknown[]>('window.posts')).length === 1, 'the dock request');
    const [[url, body]] = await page.evaluate<[string, { path: string }][]>('window.posts');
    expect(url).toBe('/api/projects/dock');
    expect(basename(body.path)).toBe(basename(repo));
    await until(async () => lines.some((l) => l.startsWith('KANBAN95 dock=')), 'the dock line');
  });
});
