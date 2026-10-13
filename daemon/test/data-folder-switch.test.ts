import './home.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { start } from '../src/server.ts';
import { localHome, normal, pointerPath, setBoardHome } from '../src/settings.ts';
import { removeTemp } from './home.ts';

let srv: Awaited<ReturnType<typeof start>>;
const shutdown = vi.fn();
const temps: string[] = [];
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
beforeAll(async () => {
  srv = await start({ repo: temp('k95-') });
}, 30_000);
afterAll(async () => {
  await srv.close();
  temps.splice(0).forEach(removeTemp);
});
afterEach(() => {
  rmSync(pointerPath(), { force: true });
  srv.db.exec('DELETE FROM tickets');
  srv.board.shutdown = shutdown;
  shutdown.mockClear();
});
const put = (path: unknown) => fetch(`http://127.0.0.1:${srv.port}/api/data-folder`, {
  method: 'PUT', headers: { cookie: `k95=${srv.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ path }),
});
const pointer = () => (existsSync(pointerPath()) ? readFileSync(pointerPath(), 'utf8').trim() : null);
const settle = () => new Promise((ok) => setTimeout(ok, 100));

describe('PUT /api/data-folder', () => {
  beforeAll(() => { srv.board.shutdown = shutdown; });

  it('points the pointer file at an existing folder, restarts the board with 75 and audits config.write', async () => {
    const data = temp('k95-data-');
    const r = await put(data);
    expect(r.status).toBe(202);
    expect(pointer()).toBe(normal(data));
    expect((await (await fetch(`http://127.0.0.1:${srv.port}/api/data-folder`, { headers: { cookie: `k95=${srv.secret}` } })).json()).path).toBe(normal(data));
    await settle();
    expect(shutdown).toHaveBeenCalledWith(75);
    expect(srv.db.prepare("SELECT outcome FROM audit WHERE tool = 'config.write'").all()).toContainEqual({ outcome: 'ok' });
  });

  it('refuses a folder that does not exist, or a relative path, naming it, and leaves the pointer alone', async () => {
    const data = temp('k95-data-');
    setBoardHome(data);
    const missing = join(data, 'nope');
    const r = await put(missing);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain(missing);
    expect(existsSync(missing)).toBe(false);
    const rel = await put('relative/dir');
    expect(rel.status).toBe(400);
    expect((await rel.json()).error).toContain('relative/dir');
    expect(pointer()).toBe(normal(data));
    await settle();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('refuses while agents run, naming the count as Update now does', async () => {
    srv.db.exec("INSERT INTO tickets (title, status) VALUES ('a', 'in_progress'), ('b', 'testing')");
    const r = await put(temp('k95-data-'));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('Data folder not changed: 2 agents are running. Change it when they finish.');
    expect(pointer()).toBe(null);
    await settle();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('removes the pointer file when given the local home itself', async () => {
    setBoardHome(temp('k95-data-'));
    expect(pointer()).not.toBe(null);
    expect((await put(localHome())).status).toBe(202);
    expect(existsSync(pointerPath())).toBe(false);
  });
});
