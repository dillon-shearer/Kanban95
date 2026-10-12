import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { start, startSetup } from '../src/server.ts';
import { firstProject } from '../src/setup.ts';
import { normal, pointerPath, readProjects, same } from '../src/settings.ts';
import { browser, until, type Page } from './cdp.ts';
import { removeTemp } from './home.ts';

let srv: Awaited<ReturnType<typeof startSetup>>;
let page: Page;
const done: string[] = [];
const data = mkdtempSync(join(tmpdir(), 'k95-data-'));
const project = mkdtempSync(join(tmpdir(), 'k95-'));

beforeAll(async () => {
  srv = await startSetup({ done: (repo) => done.push(repo) });
  page = await browser();
  const base = `http://127.0.0.1:${srv.port}/`;
  await page.send('Page.navigate', { url: `${base}?k95=${srv.secret}` });
  await until(() => page.evaluate(`document.readyState === 'complete' && location.href === ${JSON.stringify(base)} && !!document.getElementById('data')?.value`), 'the setup page');
}, 30_000);
afterAll(async () => {
  await page?.close();
  await srv?.close();
  removeTemp(data);
  removeTemp(project);
});

const fill = (id: string, v: string) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(v)}`);
const submit = () => page.evaluate(`document.getElementById('next').click()`);

it('opens on the setup page when no project is listed, the default data folder filled in', async () => {
  expect(firstProject()).toBeUndefined();
  expect(await page.evaluate('document.title')).toBe('Kanban95 Setup');
  expect(await page.evaluate(`document.getElementById('data').value`)).toBe(process.env.KANBAN95_HOME);
});

it('refuses a project folder that does not exist, with a message on the page', async () => {
  await fill('data', data);
  await fill('project', join(project, 'missing'));
  await submit();
  await until(() => page.evaluate(`!document.getElementById('error').hidden`), 'the error');
  expect(await page.evaluate(`document.getElementById('error').textContent`)).toMatch(/does not exist/);
  expect(done).toEqual([]);
  expect(existsSync(pointerPath())).toBe(false);
});

it('Next writes the pointer, lists the project in the new data folder, and a daemon without an argument then serves it', async () => {
  await fill('project', project);
  await submit();
  await until(() => done.length === 1, 'setup done');
  expect(same(done[0], normal(project))).toBe(true);
  expect(readFileSync(pointerPath(), 'utf8').trim()).toBe(normal(data));
  expect(readProjects().map((p) => p.path)).toEqual([normal(project)]);
  expect(existsSync(join(data, 'projects.json'))).toBe(true);

  const repo = firstProject();
  expect(repo).toBe(normal(project));
  const board = await start({ repo });
  try {
    expect(same(board.board.repo, normal(project))).toBe(true);
    expect(existsSync(join(project, '.kanban95', 'board.db'))).toBe(true);
  } finally {
    await board.close();
  }
}, 60_000);
