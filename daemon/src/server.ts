// Kanban95 daemon: static UI, /health, /api (operator) and /mcp (agents) on 127.0.0.1:<random port>, backed by <repo>/.kanban95/board.db.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { handleApi } from './api.js';
import { openDb } from './db.js';
import { handleMcp } from './mcp.js';
import { initTemplates } from './templates.js';

export const UI_DIR = resolve(import.meta.dirname, '../../ui');
const LOOPBACK = '127.0.0.1';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
};

export interface Config {
  host?: string;
  port?: number;
  /** Repo whose .kanban95/board.db this daemon owns. */
  repo?: string;
}

/** Rejects any bind address other than loopback. The daemon is never reachable off-host. */
export function validateConfig(c: Config): { host: typeof LOOPBACK; port: number } {
  if (c.host !== undefined && c.host !== LOOPBACK) {
    throw new Error(`refusing to bind ${c.host}: the daemon only listens on ${LOOPBACK}`);
  }
  const port = c.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port ${c.port}`);
  return { host: LOOPBACK, port };
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handle(db: DatabaseSync, self: string, req: IncomingMessage, res: ServerResponse) {
  // The shell loads the UI from this origin, so the CSP must come from here:
  // Tauri only injects its configured CSP into pages it serves itself.
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Only our own origin may talk to us: blocks DNS rebinding and cross-site requests from other local pages.
  if (req.headers.host !== self || (req.headers.origin !== undefined && req.headers.origin !== `http://${self}`)) {
    return send(res, 403, 'forbidden origin');
  }

  const url = new URL(req.url ?? '/', `http://${self}`);
  if (url.pathname.startsWith('/api/')) return handleApi(db, req, res, url);
  if (url.pathname === '/mcp') return handleMcp(db, req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  if (url.pathname === '/health') return send(res, 200, JSON.stringify({ ok: true }), 'application/json');

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'bad request');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = resolve(UI_DIR, '.' + pathname);
  if (!file.startsWith(UI_DIR + sep)) return send(res, 403, 'forbidden');
  const type = MIME[extname(file)];
  if (!type) return send(res, 404, 'not found');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return send(res, 404, 'not found');

  res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

export function start(config: Config = {}): Promise<{ port: number; db: DatabaseSync; close: () => Promise<void> }> {
  const { host, port } = validateConfig(config);
  const repo = config.repo ?? process.cwd();
  const db = openDb(repo);
  initTemplates(repo);
  let self = '';
  const server = createServer((req, res) => {
    handle(db, self, req, res).catch(() => send(res, 500, 'internal error'));
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return fail(new Error('no address'));
      self = `${LOOPBACK}:${addr.port}`;
      ok({
        port: addr.port,
        db,
        close: () => new Promise((r) => server.close(() => { db.close(); r(); })),
      });
    });
  });
}

if (import.meta.main) {
  const { port } = await start({
    port: process.env.KANBAN95_PORT ? Number(process.env.KANBAN95_PORT) : 0,
    repo: process.argv[2],
  });
  console.log(`KANBAN95 port=${port}`);
  // The parent (Tauri shell) holds our stdin. When it dies the pipe closes and we leave with it.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
