import './home.ts';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { boardHome } from '../src/settings.ts';
import { removeTemp } from './home.ts';

const win = process.platform === 'win32';
let repo: string;
let bin: string;
let srv: Awaited<ReturnType<typeof start>>;
const PATH = process.env.PATH;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
  srv = await start({ repo });
});
afterEach(() => {
  process.env.PATH = PATH;
  rmSync(join(boardHome(), 'settings.json'), { force: true });
});
afterAll(async () => {
  await srv.close();
  removeTemp(repo);
  removeTemp(bin);
});

function fake(name: string, js: string) {
  const script = join(bin, `${name}.mjs`);
  writeFileSync(script, js);
  if (win) return writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}"\r\n`);
  writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
  chmodSync(join(bin, name), 0o755);
}
const onlyFakes = () => {
  process.env.PATH = [bin, win ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/bin'].join(delimiter);
};
const get = async () => {
  const r = await fetch(`http://127.0.0.1:${srv.port}/api/requirements`, { headers: { cookie: `k95=${srv.secret}` } });
  expect(r.status).toBe(200);
  return r.json();
};
const MISSING = { found: false, version: null };

it('finds a git on PATH with its version and reports claude and codex missing', async () => {
  fake('git', `console.log('git version 9.9.9.fake')`);
  onlyFakes();
  expect(await get()).toEqual({ git: { found: true, version: 'git version 9.9.9.fake' }, claude: MISSING, codex: MISSING });
});

it('reports a configured executable that does not exist as missing, not an error', async () => {
  mkdirSync(boardHome(), { recursive: true });
  writeFileSync(join(boardHome(), 'settings.json'), JSON.stringify({ paths: { claude: join(bin, 'nope', 'claude.exe').replaceAll('\\', '/') } }));
  fake('claude', `console.log('1.0.0 (Claude Code)')`);
  onlyFakes();
  expect((await get()).claude).toEqual(MISSING);
});

it('answers within 5 s when an executable hangs, and reports it missing', async () => {
  fake('codex', `setTimeout(() => {}, 60_000)`);
  onlyFakes();
  const t = Date.now();
  expect((await get()).codex).toEqual(MISSING);
  expect(Date.now() - t).toBeLessThan(5_000);
}, 15_000);
