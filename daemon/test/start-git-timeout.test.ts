import './home.ts';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { removeTemp } from './home.ts';

const ENTRY = resolve(import.meta.dirname, '../dist/server.js');
const repo = mkdtempSync(join(tmpdir(), 'k95-hang-'));
afterAll(async () => {
  writeFileSync(join(repo, 'stop-hook'), '');
  await new Promise((r) => setTimeout(r, 2_000));
  removeTemp(repo);
});

const STEPS = ['data home', 'gitignore', 'db', 'brain', 'templates', 'projects', 'git init', 'listen', 'register', 'file mode', 'template commit', 'gitignore commit', 'rev-parse', 'janitor', 'release', 'recover', 'tick'];

it('a git that never answers holds the start for one capped wait: the port line comes within 10 s, after a timing line per step', async () => {
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\ni=0\nwhile [ ! -f stop-hook ] && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done\n');
  chmodSync(hook, 0o755);
  writeFileSync(join(repo, 'a.txt'), 'a\n');

  const began = Date.now();
  const child = spawn(process.execPath, [ENTRY, repo], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KANBAN95_SECRET: 'c'.repeat(64) } });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  try {
    const [chunk] = await once(child.stdout, 'data');
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(String(chunk)).toMatch(/^KANBAN95 port=\d+\r?\n$/);
    const end = Date.now() + 2_000;
    while (!err.includes('[start] tick') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect([...err.matchAll(/^\[start\] (.+) \d+\r?$/gm)].map((m) => m[1])).toEqual(STEPS);
    expect(err).toMatch(/\[git\] no git repo with a commit, so no ticket can launch: git did not answer within 5 s/);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) await once(child, 'exit');
  }
}, 30_000);
