import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { start, validateConfig } from '../src/server.ts';

const ENTRY = resolve(import.meta.dirname, '../dist/server.js');
const repo = mkdtempSync(join(tmpdir(), 'k95-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('bind address', () => {
  it.each(['0.0.0.0', '::', '::1', 'localhost', '192.168.1.10'])('rejects %s', (host) => {
    expect(() => validateConfig({ host })).toThrow(/refusing to bind/);
  });
  it('accepts 127.0.0.1 and defaults to a random port', () => {
    expect(validateConfig({ host: '127.0.0.1' })).toEqual({ host: '127.0.0.1', port: 0 });
    expect(validateConfig({})).toEqual({ host: '127.0.0.1', port: 0 });
  });
});

describe('daemon process', () => {
  const child = spawn(process.execPath, [ENTRY, repo], { stdio: ['pipe', 'pipe', 'inherit'] });
  afterAll(() => {
    if (child.exitCode === null) child.kill();
  });

  it('prints the port handshake, answers /health, and exits when stdin closes', async () => {
    const [chunk] = await once(child.stdout, 'data');
    const line = String(chunk).trim();
    expect(line).toMatch(/^KANBAN95 port=\d+$/);
    const port = Number(line.split('=')[1]);
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
    expect(await res.json()).toEqual({ ok: true });

    child.stdin.end();
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  }, 10_000);
});

describe('static files', () => {
  it('serves the UI but nothing above it', async () => {
    const { port, close } = await start({ repo });
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/`)).status).toBe(200);
      expect((await fetch(`${base}/vendor/98.css`)).headers.get('content-type')).toMatch(/text\/css/);
      const escapes = ['/../package.json', '/..%5c..%5cpackage.json', '/vendor/%2e%2e/%2e%2e/package.json', '/package.json'];
      for (const p of escapes) {
        const res = await fetch(`${base}${p}`);
        expect(res.status, p).toBeGreaterThanOrEqual(403);
      }
      expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
    } finally {
      await close();
    }
  });
});
