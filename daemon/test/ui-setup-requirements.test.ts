import './home.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startSetup } from '../src/server.ts';
import { browser, until, type Page } from './cdp.ts';
import { removeTemp } from './home.ts';

const win = process.platform === 'win32';
const PATH = process.env.PATH;
let srv: Awaited<ReturnType<typeof startSetup>>;
let page: Page;
const done: string[] = [];
const data = mkdtempSync(join(tmpdir(), 'k95-data-'));
const project = mkdtempSync(join(tmpdir(), 'k95-'));
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));

beforeAll(async () => {
  writeFileSync(join(bin, win ? 'git.cmd' : 'git'), win ? '@echo git version 9.9.9.fake\r\n' : '#!/bin/sh\necho git version 9.9.9.fake\n', { mode: 0o755 });
  process.env.PATH = [bin, win ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32') : '/bin'].join(delimiter);
  srv = await startSetup({ done: (repo) => done.push(repo) });
  page = await browser();
  const base = `http://127.0.0.1:${srv.port}/`;
  await page.send('Page.navigate', { url: `${base}?k95=${srv.secret}` });
  await until(() => page.evaluate(`document.querySelectorAll('#requirements .k95-requirement').length === 3`), 'the requirements');
}, 30_000);
afterAll(async () => {
  process.env.PATH = PATH;
  await page?.close();
  await srv?.close();
  removeTemp(data);
  removeTemp(project);
  removeTemp(bin);
});

const rows = () => page.evaluate<[string, boolean, string[]][]>(`[...document.querySelectorAll('#requirements .k95-requirement')].map((r) => [
  r.querySelector('.field-row').textContent, !!r.querySelector('.k95-requirement-hint'), [...r.querySelectorAll('a')].map((a) => a.href)])`);

it('lists git found with its version and Claude Code and Codex missing, each missing one with an install hint', async () => {
  expect(await rows()).toEqual([
    ['git: found (git version 9.9.9.fake)', false, []],
    ['Claude Code: missing', true, ['https://docs.anthropic.com/en/docs/claude-code']],
    ['Codex: missing', true, ['https://github.com/openai/codex']],
  ]);
});

it('every install hint link answers 200', async () => {
  process.env.PATH = join(process.env.SystemRoot ?? 'C:\Windows', 'System32');
  if (!win) process.env.PATH = '/nonexistent';
  await page.evaluate(`document.querySelector('#requirements .k95-requirements-check').click()`);
  await until(async () => { const r = await rows(); return r.length === 3 && r.every(([, hint]) => hint); }, 'all three missing');
  const urls = (await rows()).flatMap(([, , a]) => a);
  expect(urls).toHaveLength(3);
  for (const u of urls) expect([u, (await fetch(u, { redirect: 'follow' })).status]).toEqual([u, 200]);
}, 30_000);

it('Next still submits with items missing', async () => {
  await page.evaluate(`document.getElementById('data').value = ${JSON.stringify(data)}; document.getElementById('project').value = ${JSON.stringify(project)}`);
  await page.evaluate(`document.getElementById('next').click()`);
  await until(() => done.length === 1, 'setup done');
});
