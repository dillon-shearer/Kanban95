import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
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
  const secret = 'a'.repeat(64);
  const child = spawn(process.execPath, [ENTRY, repo], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, KANBAN95_SECRET: secret } });
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
    expect(res.headers.get('content-security-policy')).toBe(
      `default-src 'self' http://127.0.0.1:${port} ws://127.0.0.1:${port}; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'`,
    );
    expect(await res.json()).toEqual({ ok: true });
    // The secret came in through the environment: /api takes it, and refuses a request without it.
    expect((await fetch(`http://127.0.0.1:${port}/api/tickets`, { headers: { cookie: `k95=${secret}` } })).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/tickets`)).status).toBe(401);

    child.stdin.end();
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  }, 10_000);
});

describe('shell secret', () => {
  it('refuses to start without a secret in its environment, before it opens a port', async () => {
    const { KANBAN95_SECRET: _, ...env } = process.env;
    const child = spawn(process.execPath, [ENTRY, repo], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const [code] = await once(child, 'exit');
    expect(code).toBe(1);
    expect(out).toBe(''); // no port handshake
  }, 10_000);

  it('refuses /api and /events without the secret, and a stale secret after a restart', async () => {
    let srv = await start({ repo });
    const stale = srv.secret;
    const status = (path: string, cookie?: string) =>
      fetch(`http://127.0.0.1:${srv.port}${path}`, { headers: cookie ? { cookie } : {} }).then((r) => r.status);
    const upgrade = (cookie: string) => new Promise<number | undefined>((ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/events`, { origin: `http://127.0.0.1:${srv.port}`, headers: { cookie } });
      ws.on('unexpected-response', (_req, res) => ok(res.statusCode));
      ws.on('open', () => { ok(101); ws.close(); });
      ws.on('error', () => {});
    });
    try {
      expect(await status('/api/tickets')).toBe(401);
      expect(await status('/api/tickets', 'k95=')).toBe(401);
      expect(await status('/api/tickets', `k95=${stale}`)).toBe(200);
      expect(await status('/api/tickets', `other=1; k95=${stale}`)).toBe(200);
      expect(await upgrade('k95=nope')).toBe(401);
      expect(await upgrade(`k95=${stale}`)).toBe(101);

      await srv.close();
      srv = await start({ repo });
      expect(srv.secret).not.toBe(stale);
      expect(await status('/api/tickets', `k95=${stale}`)).toBe(401);
      expect(await upgrade(`k95=${stale}`)).toBe(401);
      expect(await status('/api/tickets', `k95=${srv.secret}`)).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('two boards in one browser keep their own cookies: each daemon takes its own among both, never the other one', async () => {
    const a = await start({ repo });
    const b = await start({ repo });
    try {
      const status = (port: number, cookie: string) => fetch(`http://127.0.0.1:${port}/api/tickets`, { headers: { cookie } }).then((r) => r.status);
      const both = `k95-${a.port}=${a.secret}; k95-${b.port}=${b.secret}`;
      expect(await status(a.port, both)).toBe(200);
      expect(await status(b.port, both)).toBe(200);
      expect(await status(a.port, `k95-${b.port}=${b.secret}`)).toBe(401);
    } finally {
      await b.close();
      await a.close();
    }
  });

  it('trades ?k95=<secret> for an HttpOnly cookie and a redirect to /, and refuses a wrong one', async () => {
    const srv = await start({ repo });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const ok = await fetch(`${base}/?k95=${srv.secret}`, { redirect: 'manual' });
      expect(ok.status).toBe(302);
      expect(ok.headers.get('location')).toBe('/');
      expect(ok.headers.get('set-cookie')).toBe(`k95-${srv.port}=${srv.secret}; HttpOnly; SameSite=Strict; Path=/`);
      const bad = await fetch(`${base}/?k95=guess`, { redirect: 'manual' });
      expect(bad.status).toBe(401);
      expect(bad.headers.get('set-cookie')).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it('keeps the secret out of the audit log', async () => {
    const srv = await start({ repo });
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/tickets`, {
        method: 'POST', headers: { cookie: `k95=${srv.secret}` }, body: JSON.stringify({ title: 'audited' }),
      });
      expect(r.status).toBe(201);
      const rows = JSON.stringify(srv.db.prepare('SELECT * FROM audit').all());
      expect(rows).toContain('tickets.create');
      expect(rows).not.toContain(srv.secret);
    } finally {
      await srv.close();
    }
  });
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
