import './home.ts';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { killTree } from '../src/launcher.ts';
import { brainstorm, changed, events } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';
import { globalPath } from '../src/settings.ts';
import { removeTemp } from './home.ts';

const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const PATH0 = process.env.PATH;
const dirs: string[] = [bin];
const until = async (f: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

let srv: Awaited<ReturnType<typeof start>>;
const connect = async (path: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}${path}`, { origin: `http://127.0.0.1:${srv.port}`, headers: { cookie: `k95=${srv.secret}` } });
  ws.on('error', () => {});
  let seen = '';
  ws.on('message', (m) => (seen += String(m)));
  await once(ws, 'open');
  return { ws, seen: () => seen, closed: once(ws, 'close').then(([code]) => code as number) };
};
const unmasked = (ws: WebSocket) => (ws as unknown as { _socket: { write: (b: Buffer) => void } })._socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));

beforeAll(() => {
  writeFileSync(join(bin, 'fake.mjs'), "console.log('FAKE UP'); process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => process.stdout.write('got:' + d.trim() + '\\n'));\n");
  writeFileSync(join(bin, 'claude.cmd'), '@node "%~dp0fake.mjs" %*\r\n');
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexec node "$(dirname "$0")/fake.mjs" "$@"\n', { mode: 0o755 });
  process.env.PATH = bin + delimiter + PATH0;
  mkdirSync(process.env.KANBAN95_HOME!, { recursive: true });
  writeFileSync(globalPath('models'), JSON.stringify({ cli: 'claude', claude: { plan: { model: 'm' } } }));
});
afterAll(() => {
  process.env.PATH = PATH0;
  for (const d of dirs) removeTemp(d);
});
beforeEach(async () => {
  const repo = mkdtempSync(join(tmpdir(), 'k95-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  dirs.push(repo);
  srv = await start({ repo });
});
afterEach(async () => {
  await srv.close();
});

describe('websocket errors', { timeout: 60_000 }, () => {
  it('/events: an oversized or malformed frame closes only that client, drops its listeners, and another client keeps getting events', async () => {
    const before = events.listenerCount('change');
    const good = await connect('/events');
    const big = await connect('/events');
    const bad = await connect('/events');
    expect(events.listenerCount('change')).toBe(before + 3);
    big.ws.send('x'.repeat(70_000));
    unmasked(bad.ws);
    expect(await big.closed).not.toBe(1000);
    expect(await bad.closed).not.toBe(1000);
    await until(() => events.listenerCount('change') === before + 1);
    changed(null);
    await until(() => good.seen().includes('"ticket":null'));
    good.ws.close();
    await good.closed;
    await until(() => events.listenerCount('change') === before);
  });

  it('/pty: an oversized frame closes only that client; another client on the same session still types and reads', async () => {
    const s = brainstorm(srv.board);
    await until(() => s.scrollback().includes('FAKE UP'));
    const good = await connect(`/pty/${s.key}`);
    const big = await connect(`/pty/${s.key}`);
    const bad = await connect(`/pty/${s.key}`);
    big.ws.send(JSON.stringify({ data: 'y'.repeat(70_000) }));
    unmasked(bad.ws);
    expect(await big.closed).not.toBe(1000);
    expect(await bad.closed).not.toBe(1000);
    good.ws.send(JSON.stringify({ data: 'ping\r' }));
    await until(() => good.seen().includes('got:ping'));
    expect(good.seen()).not.toContain('yyyy');
    killTree(s.pty);
    await good.closed;
    await s.done;
  });
});
