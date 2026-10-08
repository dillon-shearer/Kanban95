import './home.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { start } from '../src/server.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'k95-'));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('POST /api/restart in-process', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  const shutdown = vi.fn();
  beforeAll(async () => {
    srv = await start({ repo: temp() });
    srv.board.shutdown = shutdown;
  });
  afterAll(() => srv.close());
  const call = (method: string, path: string) => fetch(`http://127.0.0.1:${srv.port}${path}`, { method, headers: { cookie: `k95=${srv.secret}` } });

  it('returns 409 with the compiler output when the build fails, and the board keeps running', async () => {
    // A repo checkout (it has daemon/src) whose build fails the way tsc does.
    const root = temp();
    mkdirSync(join(root, 'daemon', 'src'), { recursive: true });
    const script = "console.log('src/api.ts(1,1): error TS2322: nope'); process.exit(2)";
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: `node -e "${script}"` } }));
    srv.board.root = root;
    const r = await call('POST', '/api/restart');
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain('error TS2322: nope');
    await new Promise((ok) => setTimeout(ok, 100));
    expect(shutdown).not.toHaveBeenCalled();
    expect((await call('GET', '/api/tickets')).status).toBe(200);
    expect(srv.db.prepare("SELECT outcome FROM audit WHERE tool = 'board.restart'").all()).toEqual([{ outcome: 'error' }]);
  }, 30_000);
});

describe('POST /api/restart from an installed layout', () => {
  it('builds nothing, answers that no shell is present, and exits 75', async () => {
    // What shell/stage.mjs ships: built daemon, no daemon/src. Staged inside node_modules so its imports resolve there by
    // walking up, with no link to clean up.
    const app = mkdtempSync(join(ROOT, 'node_modules', '.k95-app-'));
    temps.push(app);
    for (const p of ['daemon/dist', 'daemon/migrations', 'daemon/package.json', 'daemon/voice-model.json', 'templates']) cpSync(join(ROOT, p), join(app, p), { recursive: true });
    const secret = 'b'.repeat(64);
    const { KANBAN95_SHELL: _, ...env } = process.env;
    const child = spawn(process.execPath, [join(app, 'daemon/dist/server.js'), temp()], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...env, KANBAN95_SECRET: secret } });
    const exited = once(child, 'exit');
    const [chunk] = await once(child.stdout, 'data');
    const port = Number(/port=(\d+)/.exec(String(chunk))![1]);
    const r = await fetch(`http://127.0.0.1:${port}/api/restart`, { method: 'POST', headers: { cookie: `k95=${secret}` } });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ restarting: true, shell: false });
    const [code] = await exited;
    expect(code).toBe(75);
  }, 30_000);
});
