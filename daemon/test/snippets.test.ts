import './home.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildContext } from '../src/context.ts';
import { start } from '../src/server.ts';
import { globalPath, projectPath } from '../src/settings.ts';

let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let ticket: number;
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'k95-snip-'));
  srv = await start({ repo });
  ticket = Number(srv.db.prepare("INSERT INTO tickets (title) VALUES ('t')").run().lastInsertRowid);
});
afterAll(async () => {
  await srv.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(dirname(projectPath('snippets', repo)), { recursive: true, force: true });
});
afterEach(() => {
  for (const f of [globalPath('snippets'), globalPath('preferences'), projectPath('snippets', repo)]) rmSync(f, { force: true });
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const prefs = () => buildContext(srv.db, repo, ticket, 'worker').preferences;
const put = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};

describe('injection', () => {
  it('a snippet that is on follows the preferences text; one that is off is left out', () => {
    put(globalPath('preferences'), 'Be brief.\n');
    put(globalPath('snippets'), [{ name: 'a', text: 'Say hello.', on: true }, { name: 'b', text: 'Say goodbye.', on: false }]);
    expect(prefs()).toBe('Be brief.\n\nSay hello.');
  });

  it('two snippets that are on keep list order, and no name reaches the prompt', () => {
    put(globalPath('snippets'), [{ name: 'zeta-name', text: 'Second? no, first.', on: true }, { name: 'alpha-name', text: 'Then this.', on: true }]);
    const p = prefs();
    expect(p).toBe('Second? no, first.\n\nThen this.');
    expect(p).not.toContain('zeta-name');
    expect(p).not.toContain('alpha-name');
  });

  it('no preferences file and no snippets.json is (none)', () => {
    expect(prefs()).toBe('(none)');
  });

  it('a corrupt snippets.json does not throw, injects nothing and writes one stderr line naming the file', () => {
    put(globalPath('preferences'), 'Be brief.');
    put(globalPath('snippets'), '[{"name": "a", "text": "x", "on": tru');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(prefs()).toBe('Be brief.');
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain(globalPath('snippets'));
      put(globalPath('snippets'), [{ name: 'a', text: 'x', on: 'yes' }]);
      expect(prefs()).toBe('Be brief.');
    } finally {
      err.mockRestore();
    }
  });
});

describe('REST', () => {
  it('GET is value [] when the file is absent', async () => {
    expect((await call('GET', '/api/config/snippets')).body).toEqual({ path: globalPath('snippets'), value: [] });
  });

  it('PUT writes the list and it is read back', async () => {
    const value = [{ name: 'a', text: 'x', on: true }];
    expect((await call('PUT', '/api/config/snippets', { value })).body).toEqual({ path: globalPath('snippets'), value });
    expect(JSON.parse(readFileSync(globalPath('snippets'), 'utf8'))).toEqual(value);
  });

  it('PUT refuses a bad list with 400 and writes nothing', async () => {
    const bad = [
      { name: 'x' },
      [{ text: 'x', on: true }],
      [{ name: '', text: 'x', on: true }],
      [{ name: 'a', on: true }],
      [{ name: 'a', text: 'x' }],
      [{ name: 'a', text: 'x', on: true, extra: 1 }],
      [{ name: 'a', text: 'x', on: true }, { name: 'a', text: 'y', on: false }],
      [{ name: 'a', text: 'x'.repeat(16 * 1024), on: true }],
    ];
    for (const value of bad) {
      expect((await call('PUT', '/api/config/snippets', { value })).status).toBe(400);
      expect((await call('PUT', '/api/config/snippets?scope=project', { value })).status).toBe(400);
      expect(existsSync(globalPath('snippets'))).toBe(false);
      expect(existsSync(projectPath('snippets', repo))).toBe(false);
    }
  });

  it('a project copy is used for this repo, and the global file again after DELETE override', async () => {
    await call('PUT', '/api/config/snippets', { value: [{ name: 'g', text: 'global text', on: true }] });
    expect((await call('POST', '/api/config/snippets/override')).status).toBe(200);
    expect(readFileSync(projectPath('snippets', repo), 'utf8')).toBe(readFileSync(globalPath('snippets'), 'utf8'));
    await call('PUT', '/api/config/snippets?scope=project', { value: [{ name: 'p', text: 'project text', on: true }] });
    expect(prefs()).toBe('project text');
    expect((await call('DELETE', '/api/config/snippets/override')).status).toBe(200);
    expect(prefs()).toBe('global text');
  });

  it('a new project copy with no global file starts as []', async () => {
    expect((await call('POST', '/api/config/snippets/override')).body).toMatchObject({ value: [], overridden: true });
    expect(readFileSync(projectPath('snippets', repo), 'utf8')).toBe('[]\n');
    await call('DELETE', '/api/config/snippets/override');
  });
});
