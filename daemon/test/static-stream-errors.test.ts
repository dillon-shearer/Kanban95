import './home.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeTemp } from './home.ts';

const fault = vi.hoisted(() => ({ mode: null as null | 'error' | 'stall', streams: [] as import('node:stream').Readable[] }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    const mode = fault.mode;
    fault.mode = null;
    if (!mode) return fs.createReadStream(...args);
    const s = new Readable({
      read() {
        if (this.readableLength) return;
        this.push(Buffer.from('partial'));
        if (mode === 'error') setImmediate(() => this.destroy(Object.assign(new Error('EACCES: read failed'), { code: 'EACCES' })));
      },
    });
    fault.streams.push(s);
    return s;
  }) as typeof fs.createReadStream;
  return { ...fs, default: { ...fs, createReadStream }, createReadStream };
});

const { start } = await import('../src/server.ts');

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let base: string;
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  removeTemp(repo);
});

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  return ok();
};

describe('static file streaming', () => {
  it('fails only the affected response when the read fails after stat, and keeps serving', async () => {
    fault.mode = 'error';
    const res = await fetch(`${base}/index.html`);
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
    expect(fault.streams.at(-1)!.destroyed).toBe(true);

    expect((await fetch(`${base}/health`)).status).toBe(200);
    const again = await fetch(`${base}/index.html`);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('<html');
  });

  it('releases the input stream when the client disconnects mid-body', async () => {
    fault.mode = 'stall';
    const ctl = new AbortController();
    const res = await fetch(`${base}/index.html`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    const s = fault.streams.at(-1)!;
    expect(s.destroyed).toBe(false);
    ctl.abort();
    expect(await until(() => s.destroyed)).toBe(true);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('keeps GET and HEAD headers and bodies as before', async () => {
    const get = await fetch(`${base}/index.html`);
    const body = await get.text();
    expect(get.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(Number(get.headers.get('content-length'))).toBe(Buffer.byteLength(body));
    expect(get.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');

    const head = await fetch(`${base}/index.html`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'));
    expect(await head.text()).toBe('');
    expect((await fetch(`${base}/missing.html`)).status).toBe(404);
  });
});
