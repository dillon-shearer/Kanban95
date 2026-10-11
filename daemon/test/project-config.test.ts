import './home.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/context.ts';
import { worktreesRoot } from '../src/git.ts';
import { start } from '../src/server.ts';
import { globalPath, projectPath, readConfig, repoKey, runSettings, writeConfig } from '../src/settings.ts';
import { render } from '../src/templates.ts';

const home = () => process.env.KANBAN95_HOME!;
const own = (repo: string, file: string) => join(home(), 'projects', repoKey(repo), file);

describe('resolution', () => {
  const a = mkdtempSync(join(tmpdir(), 'k95-a-'));
  const b = mkdtempSync(join(tmpdir(), 'k95-b-'));
  afterAll(() => {
    for (const d of [a, b, dirname(own(a, 'x'))]) rmSync(d, { recursive: true, force: true });
  });

  it('the project dir uses the same repo key as the worktrees root', () => {
    expect(basename(worktreesRoot(a))).toBe(repoKey(a));
    expect(projectPath('models', a)).toBe(own(a, 'models.json'));
  });

  it('runSettings for a repo with a project models.json uses it; a repo without one gets the global file', () => {
    writeConfig('models', { cli: 'claude', claude: { execute: { model: 'global-m' } } });
    mkdirSync(dirname(own(a, 'models.json')), { recursive: true });
    writeFileSync(own(a, 'models.json'), JSON.stringify({ cli: 'claude', claude: { execute: { model: 'project-m', effort: 'high' } } }));
    expect(runSettings(null, 'execute', a)).toMatchObject({ model: 'project-m', effort: 'high' });
    expect(runSettings(null, 'execute', b)).toMatchObject({ model: 'global-m', effort: 'medium' });
    expect(runSettings(null, 'execute').model).toBe('global-m');
  });

  it('a project settings.json is read whole: a key only the global file sets is not seen', () => {
    writeConfig('settings', { idle_minutes: 7, push_after_merge: false });
    writeFileSync(own(a, 'settings.json'), JSON.stringify({ idle_minutes: 3 }));
    expect(readConfig('settings', a)).toMatchObject({ idle_minutes: 3, push_after_merge: true });
    expect(readConfig('settings', b)).toMatchObject({ idle_minutes: 7, push_after_merge: false });
  });
});

describe('REST', () => {
  let repo: string;
  let srv: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'k95-'));
    srv = await start({ repo });
  });
  afterAll(async () => {
    await srv.close();
    rmSync(repo, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const audits = () => srv.db.prepare("SELECT outcome FROM audit WHERE tool = 'config.write' ORDER BY id").all().map((r) => (r as { outcome: string }).outcome);

  it('models: scope=project shows the global file until an override, which copies it; a second override is 409, delete then 404', async () => {
    const global = { cli: 'claude', claude: { execute: { model: 'g', effort: 'medium' } } };
    writeConfig('models', global);
    expect((await call('GET', '/api/config/models?scope=project')).body)
      .toEqual({ path: globalPath('models'), value: global, scope: 'project', overridden: false });
    expect((await call('POST', '/api/config/models/override')).status).toBe(200);
    expect(readFileSync(projectPath('models', repo), 'utf8')).toBe(readFileSync(globalPath('models'), 'utf8'));
    const mine = { cli: 'claude', claude: { execute: { model: 'p', effort: 'low' } } };
    expect((await call('PUT', '/api/config/models?scope=project', mine)).status).toBe(200);
    expect((await call('GET', '/api/config/models?scope=project')).body)
      .toEqual({ path: projectPath('models', repo), value: mine, scope: 'project', overridden: true });
    expect((await call('GET', '/api/config/models')).body).toEqual({ path: globalPath('models'), value: global });
    expect((await call('POST', '/api/config/models/override')).status).toBe(409);
    expect((await call('DELETE', '/api/config/models/override')).status).toBe(200);
    expect(existsSync(projectPath('models', repo))).toBe(false);
    expect(existsSync(dirname(projectPath('models', repo)))).toBe(false);
    expect((await call('DELETE', '/api/config/models/override')).status).toBe(404);
    expect(audits()).toEqual(['ok', 'ok', 'error', 'ok', 'error']);
    expect((await call('GET', '/api/config/models?scope=mine')).status).toBe(400);
  });

  it('PUT settings with scope=project writes only the project copy; the global file stays byte-identical', async () => {
    writeConfig('settings', { idle_minutes: 30 });
    const before = readFileSync(globalPath('settings'));
    expect((await call('PUT', '/api/config/settings?scope=project', { idle_minutes: 5 })).body.path).toBe(projectPath('settings', repo));
    expect(readFileSync(globalPath('settings'))).toEqual(before);
    expect(readConfig('settings', repo).idle_minutes).toBe(5);
    expect((await call('GET', '/api/config/settings?scope=project')).body).toMatchObject({ overridden: true, value: { idle_minutes: 5 } });
    expect((await call('GET', '/api/config/settings?scope=global')).body).toMatchObject({ overridden: true, scope: 'global', value: { idle_minutes: 30 } });
    await call('DELETE', '/api/config/settings/override');
  });

  it('preferences with scope=project: GET, PUT, and a run on that repo renders the project copy', async () => {
    await call('PUT', '/api/config/preferences', { value: 'global prefs' });
    expect((await call('GET', '/api/config/preferences?scope=project')).body)
      .toEqual({ path: globalPath('preferences'), value: 'global prefs', scope: 'project', overridden: false });
    expect((await call('PUT', '/api/config/preferences?scope=project', { value: 'project prefs' })).status).toBe(200);
    expect(readFileSync(globalPath('preferences'), 'utf8')).toBe('global prefs');
    expect((await call('GET', '/api/config/preferences?scope=project')).body)
      .toEqual({ path: projectPath('preferences', repo), value: 'project prefs', scope: 'project', overridden: true });
    const t = Number(srv.db.prepare("INSERT INTO tickets (title) VALUES ('t')").run().lastInsertRowid);
    expect(render(repo, 'execute', buildContext(srv.db, repo, t, 'worker'))).toContain('## Operator preferences\n\nproject prefs\n');
    expect((await call('DELETE', '/api/config/preferences/override')).status).toBe(200);
    expect(render(repo, 'execute', buildContext(srv.db, repo, t, 'worker'))).toContain('## Operator preferences\n\nglobal prefs\n');
  });
});
