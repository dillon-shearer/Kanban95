import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { NODE_VERSION, sidecarName, stageNode } from '../../shell/stage.mjs';

const target = 'aarch64-apple-darwin';
const name = `node-v${NODE_VERSION}-darwin-arm64`;
let dir = '', cache = '', out = '', archive = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'k95-stage-'));
  cache = join(dir, 'cache');
  out = join(dir, 'sidecar');
  const src = join(dir, 'src');
  mkdirSync(join(src, name, 'bin'), { recursive: true });
  writeFileSync(join(src, name, 'bin', 'node'), 'fake node');
  mkdirSync(cache);
  archive = join(cache, `${name}.tar.gz`);
  execFileSync(process.platform === 'win32' ? join(process.env.SystemRoot!, 'System32', 'tar.exe') : 'tar', ['-czf', archive, '-C', src, name]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sums = (hash: string) =>
  writeFileSync(join(cache, `SHASUMS256-v${NODE_VERSION}.txt`), `${'0'.repeat(64)}  ${name}.zip\n${hash}  ${name}.tar.gz\n`);
const offline = 'http://127.0.0.1:9';

test('an archive whose hash does not match SHASUMS256.txt fails, is deleted, and leaves no binary', async () => {
  mkdirSync(out);
  writeFileSync(join(out, sidecarName(target)), 'from an earlier stage');
  sums('f'.repeat(64));
  await expect(stageNode(target, { cache, out, base: offline })).rejects.toThrow(/does not match the published f{64}/);
  expect(existsSync(join(out, sidecarName(target)))).toBe(false);
  expect(existsSync(archive)).toBe(false);
});

test('a matching archive puts only the node binary in place under its externalBin name', async () => {
  sums(createHash('sha256').update(readFileSync(archive)).digest('hex'));
  const dest = await stageNode(target, { cache, out, base: offline });
  expect(dest).toBe(join(out, 'node-aarch64-apple-darwin'));
  expect(readFileSync(dest, 'utf8')).toBe('fake node');
  expect(sidecarName('x86_64-pc-windows-msvc')).toBe('node-x86_64-pc-windows-msvc.exe');
});
