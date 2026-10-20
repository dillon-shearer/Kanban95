import './home.ts';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runner, setRunner, tick, type Board } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';
import { initTemplates, shippedPath } from '../src/templates.ts';
import { removeTemp } from './home.ts';

const ticks = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock('../src/lifecycle.ts', async (orig) => {
  const real = await orig<typeof import('../src/lifecycle.ts')>();
  return { ...real, tick: (b: Board) => (ticks.push(b.startCommit), real.tick(b)) };
});

const ENTRY = resolve(import.meta.dirname, '../dist/server.js');
const SUBJECT = 'Update the board prompt templates to the shipped defaults';
let repo: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-early-'));
  git('init', '-q');
  git('config', 'user.name', 'Op');
  git('config', 'user.email', 'op@example.com');
  initTemplates(repo);
  const older = 'older default {{ticket}}';
  writeFileSync(join(repo, '.kanban95', 'templates', 'test.md'), older);
  const rec = JSON.parse(readFileSync(shippedPath(repo), 'utf8'));
  writeFileSync(shippedPath(repo), JSON.stringify({ ...rec, test: createHash('sha256').update(older).digest('hex') }));
  git('add', '-A');
  git('commit', '-qm', 'Seed');
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nsleep 3\n');
  chmodSync(hook, 0o755);
  ticks.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  removeTemp(repo);
});

it('prints the port line within 1 s while a 3 s pre-commit hook holds the template commit, which lands afterwards', async () => {
  const began = Date.now();
  const child = spawn(process.execPath, [ENTRY, repo], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KANBAN95_SECRET: 'c'.repeat(64) } });
  child.stderr.resume();
  try {
    const [chunk] = await once(child.stdout, 'data');
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(String(chunk)).toMatch(/^KANBAN95 port=\d+\r?\n/);
    expect(git('log', '-1', '--format=%s')).toBe('Seed');
    const end = Date.now() + 15_000;
    while (git('log', '-1', '--format=%s') !== SUBJECT && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(git('log', '-1', '--format=%s')).toBe(SUBJECT);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) await once(child, 'exit');
  }
}, 30_000);

it('runs the start tick only once startCommit holds the template commit, and no tick runs while the start is under way', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let atListen: string | undefined;
  const srv = await start({ repo, listening: () => (atListen = git('log', '-1', '--format=%s')) });
  try {
    expect(atListen).toBe('Seed');
    expect(git('log', '-1', '--format=%s')).toBe(SUBJECT);
    expect(srv.board.startCommit).toBe(git('rev-parse', 'HEAD'));
    expect(ticks).toEqual([srv.board.startCommit]);

    srv.board.starting = true;
    setRunner(srv.board, true);
    tick(srv.board);
    expect(runner(srv.board).on).toBe(true);
    srv.board.starting = false;
    tick(srv.board);
    expect(runner(srv.board)).toEqual({ on: false, why: 'nothing left to launch' });
  } finally {
    await srv.close();
  }
}, 30_000);
