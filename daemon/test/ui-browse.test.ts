import './home.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { entryPath, register } from '../src/boards.ts';
import { startSetup } from '../src/server.ts';
import { browser, until, type Page } from './cdp.ts';
import { removeTemp } from './home.ts';
import { base, page, srv } from './ui.ts';

const W = '[data-win="settings"]';
const write = process.stdout.write.bind(process.stdout);
let asked: { kind: string; token: string } | null = null;
let target = { port: 0, secret: '' };

const shell = () => vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...rest) => {
  const m = /^KANBAN95 pick=.* (folder|file) ([0-9a-f]{32})\n$/.exec(String(chunk));
  if (m) asked = { kind: m[1]!, token: m[2]! };
  return String(chunk).startsWith('KANBAN95 ') ? true : write(chunk, ...(rest as []));
});
const answer = async (body: unknown) => {
  const { token } = await until(() => asked, 'the pick= line');
  asked = null;
  const r = await fetch(`http://127.0.0.1:${target.port}/api/pick/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `k95=${target.secret}` },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(204);
};

async function covers(p: Page, input: string, button: string, kind: string, picked: string) {
  const value = () => p.evaluate<string>(`document.querySelector(${JSON.stringify(input)}).value`);
  const disabled = () => p.evaluate<boolean>(`document.querySelector(${JSON.stringify(button)}).disabled`);
  expect(await p.evaluate(`document.querySelector(${JSON.stringify(button)}).hidden`)).toBe(false);
  await p.evaluate(`document.querySelector(${JSON.stringify(input)}).value = 'typed by hand'`);

  await p.evaluate(`document.querySelector(${JSON.stringify(button)}).click()`);
  expect((await until(() => asked, 'the pick= line')).kind).toBe(kind);
  expect(await disabled()).toBe(true);
  await answer({ cancelled: true });
  await until(async () => !(await disabled()), 'the button enabled after a cancel');
  expect(await value()).toBe('typed by hand');

  await p.evaluate(`document.querySelector(${JSON.stringify(button)}).click()`);
  await answer({ path: picked });
  await until(async () => (await value()) === picked, 'the picked path in the box');
  expect(await disabled()).toBe(false);
}

const tab = async (name: string, ready: string) => {
  await page.evaluate(`[...document.querySelectorAll('${W} [role=tab] a')].find((t) => t.textContent === ${JSON.stringify(name)}).click()`);
  await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(ready)})`), `the ${name} tab`);
};
const settings = async () => {
  await page.goto(base);
  await until(() => page.evaluate(`!!document.querySelector('[data-win="board"]')`), 'the board');
  await page.evaluate(`document.querySelector('[data-icon="Settings"]').dispatchEvent(new MouseEvent('dblclick'))`);
  await until(() => page.evaluate(`!!document.querySelector('#scope-project')`), 'the switch');
};
const claude = 'input[placeholder="claude (found on PATH)"]';
const codex = 'input[placeholder="codex (found on PATH)"]';

describe('Settings Browse buttons', { timeout: 60_000 }, () => {
  let own: { repo: string; port: number; shell: number | null };
  beforeAll(() => {
    target = { port: srv.port, secret: srv.secret };
    own = JSON.parse(readFileSync(entryPath(process.pid), 'utf8'));
  });
  afterAll(() => {
    vi.restoreAllMocks();
    register(own.repo, own.port, own.shell);
    srv.board.shellId = null;
    srv.board.shell = false;
  });

  it('fill each path box with the path the shell posts back, and a cancel leaves it as typed', async () => {
    srv.board.shellId = 123;
    srv.board.shell = true;
    register(own.repo, own.port, 123);
    shell();
    await settings();
    await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(claude)})`), 'the Agents tab');
    await covers(page, claude, `${claude} ~ .k95-browse`, 'file', 'C:\\Tools\\claude.exe');
    await covers(page, codex, `${codex} ~ .k95-browse`, 'file', 'C:\\Tools\\codex.exe');
    await tab('Board', '#data-folder');
    await covers(page, '#data-folder', '#data-folder ~ .k95-browse', 'folder', 'D:\\Kanban95 data');
    await tab('Projects', '#project-add');
    await covers(page, '#project-add', '#project-add ~ .k95-browse', 'folder', 'D:\\projects\\other');
  });

  it('are not shown on a board the shell does not host', async () => {
    vi.restoreAllMocks();
    register(own.repo, own.port, null);
    srv.board.shellId = null;
    srv.board.shell = false;
    await settings();
    const hidden = () => page.evaluate<boolean[]>(`[...document.querySelectorAll('${W} .k95-browse')].map((b) => b.hidden)`);
    await until(() => page.evaluate(`!!document.querySelector(${JSON.stringify(claude)})`), 'the Agents tab');
    expect(await hidden()).toEqual([true, true]);
    await tab('Board', '#data-folder');
    expect(await hidden()).toEqual([true]);
    await tab('Projects', '#project-add');
    expect(await hidden()).toEqual([true]);
  });
});

describe('setup page Browse buttons', { timeout: 60_000 }, () => {
  const open = async (hosted: boolean) => {
    const s = await startSetup({ shell: hosted, done: () => {} });
    const p = await browser();
    const at = `http://127.0.0.1:${s.port}/`;
    await p.send('Page.navigate', { url: `${at}?k95=${s.secret}` });
    await until(() => p.evaluate(`document.readyState === 'complete' && location.href === ${JSON.stringify(at)} && !!document.getElementById('data')?.value`), 'the setup page');
    return { s, p };
  };

  it('fill the data and project folders from the shell, and a cancel leaves them as typed', async () => {
    const { s, p } = await open(true);
    const dir = mkdtempSync(join(tmpdir(), 'k95-browse-'));
    try {
      target = { port: s.port, secret: s.secret };
      shell();
      await until(() => p.evaluate(`!document.getElementById('data-browse').hidden`), 'the Browse buttons');
      await covers(p, '#data', '#data-browse', 'folder', dir);
      await covers(p, '#project', '#project-browse', 'folder', join(dir, 'project'));
    } finally {
      vi.restoreAllMocks();
      await p.close();
      await s.close();
      removeTemp(dir);
    }
  });

  it('are not shown without a shell', async () => {
    const { s, p } = await open(false);
    try {
      expect(await p.evaluate(`['data-browse', 'project-browse'].map((id) => document.getElementById(id).hidden)`)).toEqual([true, true]);
    } finally {
      await p.close();
      await s.close();
    }
  });
});
