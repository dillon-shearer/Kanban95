import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { download, modelDir, type Manifest } from '../src/voice.ts';

const FILES: Record<string, Buffer> = { 'config.json': Buffer.from('{"a":1}'), 'onnx/model.onnx': Buffer.alloc(64 * 1024, 7) };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const hits: Record<string, number> = {};
let server: Server;
let source: string;
let started: () => void = () => {};
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url!.replace(/^\/resolve\/[^/]+\//, '');
    hits[path] = (hits[path] ?? 0) + 1;
    const body = FILES[path];
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': body.length });
    started();
    for (let i = 0; i < body.length; i += 4096) {
      res.write(body.subarray(i, i + 4096));
      await new Promise((r) => setTimeout(r, 25));
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  source = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { for (const k in hits) delete hits[k]; });

const home = process.env.KANBAN95_HOME!;
const voice = pathToFileURL(join(import.meta.dirname, '../src/voice.ts')).href;
const good = (path: string) => ({ path, size: FILES[path].length, sha256: sha(FILES[path]) });
const manifest = (id: string, files: Manifest['files']): Manifest => ({ id: `test/${id}`, source, revision: 'abc', license: 'test', files });
const ts = `(await import('node:module')).registerHooks({ resolve: (s, c, next) => { try { return next(s, c); } catch (e) { if (s.endsWith('.js')) return next(s.slice(0, -3) + '.ts', c); throw e; } } });`;
const script = (m: Manifest) => ['--input-type=module', '-e', `${ts} const v = await import(${JSON.stringify(voice)}); await v.download(${JSON.stringify(m)});`];
const daemon = (m: Manifest) => promisify(execFile)(process.execPath, script(m), { env: { ...process.env, KANBAN95_HOME: home } });
const parts = (m: Manifest) => readdirSync(modelDir(m), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.part'));

it('two daemons downloading the same missing model fetch each file once and never expose a partial file', async () => {
  const m = manifest('race', [good('config.json'), good('onnx/model.onnx')]);
  const dest = join(modelDir(m), 'onnx', 'model.onnx');
  const seen = new Set<number>();
  const watch = setInterval(() => {
    try { seen.add(readFileSync(dest).length); } catch {}
  }, 2);
  try {
    await Promise.all([daemon(m), daemon(m)]);
  } finally {
    clearInterval(watch);
  }
  expect(readFileSync(dest)).toEqual(FILES['onnx/model.onnx']);
  expect(readFileSync(join(modelDir(m), 'config.json'))).toEqual(FILES['config.json']);
  expect([...seen].every((n) => n === FILES['onnx/model.onnx'].length)).toBe(true);
  expect(hits['config.json']).toBe(1);
  expect(hits['onnx/model.onnx']).toBe(1);
  expect(parts(m)).toEqual([]);
}, 60_000);

it('a daemon killed mid-download releases the lock, and the next attempt clears its part file and finishes', async () => {
  const m = manifest('killed', [good('onnx/model.onnx')]);
  const child = spawn(process.execPath, script(m), { env: { ...process.env, KANBAN95_HOME: home }, stdio: 'ignore' });
  await new Promise<void>((r) => (started = r));
  for (const end = Date.now() + 10_000; !existsSync(modelDir(m)) || parts(m).length === 0; await new Promise((r) => setTimeout(r, 5))) {
    if (Date.now() > end) throw new Error('the child never opened its part file');
  }
  child.kill();
  await new Promise((r) => child.once('exit', r));
  expect(parts(m)).toHaveLength(1);
  await download(m);
  expect(readFileSync(join(modelDir(m), 'onnx', 'model.onnx'))).toEqual(FILES['onnx/model.onnx']);
  expect(parts(m)).toEqual([]);
}, 60_000);

it('a failed attempt removes only its own part file and keeps files another attempt published', async () => {
  const m = manifest('fail', [good('config.json'), { path: 'missing.bin', size: 10, sha256: '0'.repeat(64) }]);
  await daemon(manifest('fail', [good('config.json')]));
  await expect(download(m)).rejects.toThrow('missing.bin: HTTP 404');
  expect(readFileSync(join(modelDir(m), 'config.json'))).toEqual(FILES['config.json']);
  expect(existsSync(join(modelDir(m), 'missing.bin'))).toBe(false);
  expect(parts(m)).toEqual([]);
});

it('a daemon waiting on the lock does not delete the files the holder publishes when its own fetch fails', async () => {
  const m = manifest('wait', [good('onnx/model.onnx')]);
  const holder = daemon(m);
  await new Promise<void>((r) => (started = r));
  const bad = manifest('wait', [good('onnx/model.onnx'), { path: 'missing.bin', size: 10, sha256: '0'.repeat(64) }]);
  await Promise.all([holder, expect(download(bad)).rejects.toThrow('missing.bin: HTTP 404')]);
  expect(readFileSync(join(modelDir(m), 'onnx', 'model.onnx'))).toEqual(FILES['onnx/model.onnx']);
  expect(hits['onnx/model.onnx']).toBe(1);
  expect(parts(m)).toEqual([]);
}, 60_000);
