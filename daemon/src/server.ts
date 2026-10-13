// Kanban95 daemon: static UI, /health, /api (operator), /mcp (agents), /pty and /events websockets on 127.0.0.1:<random port>, backed by <repo>/.kanban95/board.db.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { handleApi } from './api.js';
import { countBoard, entryPath, register, tellShell } from './boards.js';
import { openDb, openGlobalBrain } from './db.js';
import { git, guardFileMode, initRepo } from './git.js';
import { sweep, SWEEP_MS } from './janitor.js';
import { killAll, launch, sessions } from './launcher.js';
import { countUnpushed, events, recover, releasePending, tick, watchSilence, type Board } from './lifecycle.js';
import { handleMcp } from './mcp.js';
import { startMemoryLog } from './memlog.js';
import { idle } from './merge.js';
import { addProject, dataHome, gone, missingHome, readConfig } from './settings.js';
import { firstProject, handleSetup, setupPage } from './setup.js';
import { initTemplates } from './templates.js';
import { askForCheck } from './update.js';
import { voiceFile } from './voice.js';

const UI_DIR = resolve(import.meta.dirname, '../../ui');
const LOOPBACK = '127.0.0.1';
/** `self` is `127.0.0.1:<port>`. frame-ancestors stops another local page from framing the board (its GET carries no Origin). */
const csp = (self: string) =>
  `default-src 'self' http://${self} ws://${self}; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'`;

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
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

export interface Config {
  host?: string;
  port?: number;
  /** Repo whose .kanban95/board.db this daemon owns. */
  repo?: string;
  /** Shell-to-daemon secret required on /api, /events and /pty (docs/SECURITY.md). Random when not given. */
  secret?: string;
  shellId?: number | null;
  shell?: boolean;
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

/** Only our own origin may talk to us: blocks DNS rebinding and cross-site requests from other local pages. */
const sameOrigin = (req: IncomingMessage, self: string) =>
  req.headers.host === self && (req.headers.origin === undefined || req.headers.origin === `http://${self}`);

const COOKIE = 'k95';
const digest = (s: string) => createHash('sha256').update(s).digest();
/** Constant-time compare; hashing first evens out the lengths. */
const matches = (given: string | null | undefined, secret: string) => given != null && timingSafeEqual(digest(given), digest(secret));
/**
 * Any `k95` or `k95-<port>` cookie. Every board's webview shares one WebView2 profile and cookies ignore the port, so each
 * board sets its own name (`k95-<port>`) and the browser sends all of them to every board; one must hold this secret.
 */
const authed = (req: IncomingMessage, secret: string) =>
  [...(req.headers.cookie ?? '').matchAll(/(?:^|;\s*)k95(?:-\d+)?=([^;]*)/g)].some((m) => matches(m[1], secret));

async function handle(board: Board | null, self: string, secret: string, req: IncomingMessage, res: ServerResponse, setup?: { done: (repo?: string) => void; shell?: boolean }) {
  // The shell loads the UI from this origin, so the CSP must come from here:
  // Tauri only injects its configured CSP into pages it serves itself.
  // 'wasm-unsafe-eval' lets the local speech model's WebAssembly compile (no JS eval). Inline styles are for xterm.js, which
  // writes its theme into a <style> element; inline scripts stay blocked.
  res.setHeader('Content-Security-Policy', csp(self));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!sameOrigin(req, self)) return send(res, 403, 'forbidden origin');

  const url = new URL(req.url ?? '/', `http://${self}`);
  // The shell opens the window on /?k95=<secret>; we trade it for an HttpOnly cookie and redirect to /, so it stays out
  // of the page's history and page scripts never see it (docs/SECURITY.md).
  if (url.searchParams.has(COOKIE)) {
    if (!matches(url.searchParams.get(COOKIE), secret)) return send(res, 401, 'unauthorized');
    res.writeHead(302, { 'Set-Cookie': `${COOKIE}-${self.split(':')[1]}=${secret}; HttpOnly; SameSite=Strict; Path=/`, Location: '/', 'Content-Length': 0 });
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) {
    if (!authed(req, secret)) return send(res, 401, 'unauthorized');
    return board ? handleApi(board, req, res, url) : handleSetup(req, res, url, setup!);
  }
  if (url.pathname === '/mcp') return board ? handleMcp(board, req, res) : send(res, 404, 'not found');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  if (url.pathname === '/health') return send(res, 200, JSON.stringify({ ok: true }), 'application/json');

  if (url.pathname.startsWith('/voice-model/')) {
    const file = await voiceFile(url.pathname);
    return file ? serveFile(req, res, file, 'application/octet-stream') : send(res, 404, 'not found');
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'bad request');
  }
  if (!board && (pathname === '/' || pathname === '/setup.html')) return send(res, 200, setupPage(await readFile(resolve(UI_DIR, 'setup.html'), 'utf8')), MIME['.html']);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = resolve(UI_DIR, '.' + pathname);
  if (!file.startsWith(UI_DIR + sep)) return send(res, 403, 'forbidden');
  const type = MIME[extname(file)];
  if (!type) return send(res, 404, 'not found');
  return serveFile(req, res, file, type);
}

async function serveFile(req: IncomingMessage, res: ServerResponse, file: string, type: string) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return send(res, 404, 'not found');
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
  if (req.method === 'HEAD') return res.end();
  pipeline(createReadStream(file), res, () => {});
}

type Launch = Parameters<typeof launch>[1];

export function start(config: Config = {}): Promise<{
  port: number;
  db: DatabaseSync;
  board: Board;
  secret: string;
  launch: (o: Launch) => ReturnType<typeof launch>;
  close: () => Promise<void>;
}> {
  const { host, port } = validateConfig(config);
  const repo = config.repo ?? process.cwd();
  const secret = config.secret ?? randomBytes(32).toString('hex');
  dataHome();
  if (gone(repo)) throw new Error(`project folder ${repo} does not exist: it was deleted or moved`);
  const db = openDb(repo);
  let brain: DatabaseSync;
  try {
    brain = openGlobalBrain();
  } catch (e) {
    db.close();
    throw e;
  }
  initTemplates(repo);
  try {
    addProject(repo); // Settings → Projects lists every repo a board has run on
  } catch (e) {
    console.error(`projects.json not updated: ${(e as Error).message}`); // stderr: stdout's first line is the handshake
  }
  let self = '';
  const board: Board = { db, brain, repo, port: 0, shellId: config.shellId ?? null, shell: config.shell };
  try {
    initRepo(repo); // a plain folder becomes a local repo with one commit (docs/ARCHITECTURE.md → Daemon lifetime)
  } catch (e) {
    board.gitError = (e as Error).message;
    console.error(`[git] ${board.gitError}`);
  }
  try {
    guardFileMode(repo);
  } catch (e) {
    console.error(`[git] core.fileMode not set: ${(e as Error).message}`);
  }
  try {
    board.startCommit = git(repo, 'rev-parse', '--verify', '-q', 'HEAD');
  } catch { /* no commits yet: nothing can be stale */ }
  const server = createServer((req, res) => {
    handle(board, self, secret, req, res).catch(() => send(res, 500, 'internal error'));
  });

  // /pty/<key>: a session's terminal for xterm.js (key = run id, or minus the grant id for a brainstorm). Output goes out as text frames, starting with the scrollback so far.
  // In: JSON `{"data": "..."}` is typed into the pty, `{"resize": [cols, rows]}` resizes it. A browser always sends
  // Origin on a websocket, so here it is required, not optional.
  // /events: board events for the UI, one JSON text frame each: `{"sound": "ding" | "chord" | "done", "ticket": n}`, or
  // `{"ticket": n | null}` when that ticket (or, for null, the set of live sessions) changed. Nothing comes in.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 16 });
  let watchers = 0;
  let nap: NodeJS.Timeout | undefined;
  const doze = () => {
    if (sessions.size || watchers) {
      clearTimeout(nap);
      nap = undefined;
      return;
    }
    if (nap || !config.shell || board.closing) return;
    let minutes: number;
    try {
      minutes = readConfig('settings', repo).sleepAfterMinutes;
    } catch {
      return;
    }
    if (minutes > 0) nap = setTimeout(() => { if (!sessions.size && !watchers && !board.closing) tellShell('close', repo); }, minutes * 60_000).unref();
  };
  server.on('upgrade', (req, socket, head) => {
    const s = sessions.get(Number(/^\/pty\/(-?\d+)$/.exec(req.url ?? '')?.[1]));
    if (!req.headers.origin || !sameOrigin(req, self) || !(s || req.url === '/events')) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (!authed(req, secret)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    if (!s) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const forward = (e: unknown) => ws.send(JSON.stringify(e));
        events.on('event', forward).on('change', forward);
        watchers++;
        doze();
        ws.on('error', () => ws.terminate());
        ws.on('close', () => {
          events.off('event', forward).off('change', forward);
          watchers--;
          doze();
        });
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(s.scrollback());
      const out = s.pty.onData((d) => ws.send(d));
      const exit = s.pty.onExit(() => ws.close());
      ws.on('error', () => ws.terminate());
      ws.on('message', (m) => {
        try {
          const msg = JSON.parse(String(m));
          if (typeof msg.data === 'string') s.pty.write(msg.data);
          else if (Array.isArray(msg.resize) && msg.resize.every((n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) < 1000)) {
            s.pty.resize(msg.resize[0], msg.resize[1]);
          }
        } catch {
          // not JSON: ignored
        }
      });
      ws.on('close', () => {
        out.dispose();
        exit.dispose();
      });
    });
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return fail(new Error('no address'));
      self = `${LOOPBACK}:${addr.port}`;
      board.port = addr.port;
      const unregister = register(repo, addr.port, board.shellId ?? null); // Start → Projects on the other boards sees this one running
      const count = () => {
        countBoard(sessions.size, (db.prepare('SELECT count(*) AS n FROM tickets WHERE needs_human = 1').get() as { n: number }).n);
        doze();
      };
      events.on('change', count);
      count();
      // Janitor and recovery on start, the janitor again once a day (docs/LIFECYCLE.md).
      sweep(board).catch(() => {});
      void countUnpushed(board); // the status bar's "N commits not pushed"
      releasePending(board);
      recover(board);
      tick(board); // the runner picks up where it was
      const daily = setInterval(() => sweep(board).catch(() => {}), SWEEP_MS).unref();
      const unwatch = watchSilence(board);
      const stopMemoryLog = startMemoryLog(repo, () => sessions.values());
      ok({
        port: addr.port,
        db,
        board,
        secret,
        launch: (o) => launch(board, o),
        close: async () => {
          board.closing = true; // nothing new is spawned from here on
          clearInterval(daily);
          unwatch();
          clearTimeout(nap);
          await killAll(); // run rows and exit flags are written before the db closes
          await idle(); // and every queued merge has finished
          stopMemoryLog();
          for (const c of wss.clients) c.terminate();
          const closed = new Promise<void>((r) => server.close(() => r()));
          // A keep-alive or preconnected socket the browser still holds would keep close() waiting for the server's own timeouts
          // (30 s and more, seen with the UI tests in parallel).
          server.closeAllConnections();
          await closed;
          db.close();
          events.off('change', count);
          unregister();
          brain.close();
        },
      });
    });
  });
}

export function startSetup(config: Config & { done: (repo?: string) => void }): Promise<{ port: number; secret: string; close: () => Promise<void> }> {
  const { host, port } = validateConfig(config);
  const secret = config.secret ?? randomBytes(32).toString('hex');
  let self = '';
  const server = createServer((req, res) => {
    handle(null, self, secret, req, res, config).catch(() => send(res, 500, 'internal error'));
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return fail(new Error('no address'));
      self = `${LOOPBACK}:${addr.port}`;
      ok({
        port: addr.port,
        secret,
        close: () => {
          const closed = new Promise<void>((r) => server.close(() => r()));
          server.closeAllConnections();
          return closed;
        },
      });
    });
  });
}

if (import.meta.main) {
  // From the shell's environment, never argv (another process can read a command line). Dropped from ours at once so
  // nothing we spawn (git, hooks, agent CLIs) inherits it.
  const secret = process.env.KANBAN95_SECRET;
  const shell = process.env.KANBAN95_SHELL === '1';
  const shellId = /^\d+$/.test(process.env.KANBAN95_SHELL_ID ?? '') ? Number(process.env.KANBAN95_SHELL_ID) : null;
  delete process.env.KANBAN95_SECRET;
  delete process.env.KANBAN95_SHELL;
  delete process.env.KANBAN95_SHELL_ID;
  if (!secret || secret.length < 32) {
    console.error('KANBAN95_SECRET is missing or shorter than 32 characters: start the board through the shell (npm run dev)');
    process.exit(1);
  }
  const repo = missingHome() ? undefined : process.argv[2] ?? firstProject();
  const wanted = process.env.KANBAN95_PORT ? Number(process.env.KANBAN95_PORT) : 0;
  const started = await Promise.resolve().then(() => (repo ? start({ secret, port: wanted, repo, shellId, shell }) : startSetup({ secret, port: wanted, shell, done: () => process.exit(75) }))).catch((e) => {
    console.log((e as Error).message);
    process.exit(1);
  });
  const { port } = started;
  console.log(`KANBAN95 port=${port}`);
  if (repo) {
    const { board, close } = started as Awaited<ReturnType<typeof start>>;
    // Restart board (POST /api/restart): the same shutdown as close(), so killed agents stay unflagged and recover() resumes
    // them, then exit 75, which the shell takes as "start me again" (docs/ARCHITECTURE.md -> Restart board).
    board.shutdown = (code) => {
      if (board.closing) return;
      // ponytail: a session whose pty never exits would hold close() forever; 15 s cap, a per-step timeout if that bites.
      setTimeout(() => process.exit(code), 15_000).unref();
      close().finally(() => process.exit(code));
    };
    // The parent (Tauri shell) holds our stdin. When it dies the pipe closes and we leave with it, agents' process trees first:
    // on Windows the shell's job object would end them too, on macOS nothing would.
    process.stdin.on('end', () => board.shutdown!(0));
    process.on('exit', () => rmSync(entryPath(process.pid), { force: true })); // the running entry, also without close()
    askForCheck(board);
  } else {
    process.stdin.on('end', () => process.exit(0));
  }
  process.stdin.resume();
}
