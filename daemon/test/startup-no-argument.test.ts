import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, expect, it } from 'vitest';
import { normal, projectsPath } from '../src/settings.ts';
import { removeTemp } from './home.ts';

const ENTRY = resolve(import.meta.dirname, '../dist/server.js');
const secret = 'b'.repeat(64);
const repo = mkdtempSync(join(tmpdir(), 'k95-'));
afterAll(() => removeTemp(repo));
afterEach(() => rmSync(projectsPath(), { force: true }));

async function home(): Promise<string> {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, KANBAN95_SECRET: secret } });
  try {
    const [chunk] = await once(child.stdout, 'data');
    const port = Number(/^KANBAN95 port=(\d+)/.exec(String(chunk))![1]);
    return await (await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: `k95=${secret}` } })).text();
  } finally {
    child.stdin.end();
    if (child.exitCode === null) await once(child, 'exit');
  }
}

it('started without an argument and no listed project, the daemon serves the setup page', async () => {
  expect(await home()).toContain('/setup.js');
}, 20_000);

it('started without an argument, the daemon opens the first listed project without setup', async () => {
  mkdirSync(join(projectsPath(), '..'), { recursive: true });
  writeFileSync(projectsPath(), JSON.stringify([{ path: normal(repo), colour: '#008080' }]));
  const page = await home();
  expect(page).toContain('/app.js');
  expect(page).not.toContain('/setup.js');
}, 20_000);
