import './home.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { events } from '../src/lifecycle.ts';
import { start } from '../src/server.ts';
import { writeConfig } from '../src/settings.ts';
import { askForCheck, VERSION } from '../src/update.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let base: string;
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-update-'));
  srv = await start({ repo });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
});
afterEach(() => {
  srv.board.shell = undefined;
  srv.board.update = undefined;
  srv.db.exec('DELETE FROM tickets');
  writeConfig('settings', {});
  vi.restoreAllMocks();
});

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const report = (body: unknown, headers: Record<string, string> = {}) => call('POST', '/api/update/shell', body, headers);
const answer = (a: string) => call('POST', '/api/update', { answer: a });
const told = () => {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (lines.push(String(s)), true));
  return lines;
};
const offer = { state: 'available', version: '9.0.0', current: VERSION };

describe('the shell reports', () => {
  it('a newer release, which the UI reads and hears about', async () => {
    srv.board.shell = true;
    const heard: unknown[] = [];
    const on = (e: { update?: unknown }) => e.update && heard.push(e.update);
    events.on('event', on);
    expect((await report(offer)).status).toBe(204);
    events.off('event', on);
    expect(heard).toEqual([offer]);
    expect(await (await call('GET', '/api/update')).json()).toEqual({ version: VERSION, offer: { version: '9.0.0', current: VERSION } });
  });

  it('only from the shell: a page sends Origin, a board started by hand has no shell, and a bad report is refused', async () => {
    expect((await report(offer)).status).toBe(403);
    srv.board.shell = true;
    expect((await report(offer, { origin: base })).status).toBe(403);
    expect((await report({ state: 'available', version: '', current: '1' })).status).toBe(400);
    expect((await report({ state: 'reboot' })).status).toBe(400);
    expect(srv.board.update).toBeUndefined();
  });
});

describe('the operator answers', () => {
  it('Later drops the offer until the next check', async () => {
    srv.board.shell = true;
    await report(offer);
    expect((await answer('later')).status).toBe(204);
    expect((await (await call('GET', '/api/update')).json()).offer).toBeNull();
  });

  it('Update now is refused while agents run, naming the count, and tells the shell once they are done', async () => {
    srv.board.shell = true;
    await report(offer);
    srv.db.exec("INSERT INTO tickets (title, status) VALUES ('a', 'in_progress'), ('b', 'testing')");
    const lines = told();
    const refused = await answer('now');
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe('Not updated: 2 agents are running. Update when they finish.');
    srv.db.exec("UPDATE tickets SET status = 'backlog'");
    expect((await answer('now')).status).toBe(202);
    expect(lines).toEqual([`KANBAN95 update=${srv.board.repo}\n`]);
  });

  it('Update now with nothing offered, or without a shell, is refused', async () => {
    srv.board.shell = true;
    expect((await answer('now')).status).toBe(409);
    expect((await answer('maybe')).status).toBe(400);
    srv.board.shell = undefined;
    srv.board.update = { version: '9.0.0', current: VERSION };
    expect((await answer('now')).status).toBe(409);
    expect((await answer('check')).status).toBe(409);
  });

  it('Check for updates asks the shell to check now', async () => {
    srv.board.shell = true;
    const lines = told();
    expect((await answer('check')).status).toBe(202);
    expect(lines).toEqual([`KANBAN95 checknow=${srv.board.repo}\n`]);
  });
});

describe('the automatic check', () => {
  it('is asked for on start under the shell unless Settings turned it off', () => {
    const lines = told();
    askForCheck(srv.board);
    srv.board.shell = true;
    askForCheck(srv.board);
    writeConfig('settings', { updateCheck: false });
    askForCheck(srv.board);
    writeFileSync(join(process.env.KANBAN95_HOME!, 'settings.json'), JSON.stringify({ updateCheck: true }));
    askForCheck(srv.board);
    expect(lines).toEqual([`KANBAN95 check=${srv.board.repo}\n`, `KANBAN95 check=${srv.board.repo}\n`]);
  });
});
