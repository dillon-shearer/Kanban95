import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { worktreesRoot } from '../src/git.ts';
import { start } from '../src/server.ts';
import { boardHome, localHome, normal, pointerPath, readConfig, readProjects, runSettings, setBoardHome, writeConfig } from '../src/settings.ts';
import { removeTemp } from './home.ts';

const KH = process.env.KANBAN95_HOME;
const temps: string[] = [];
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
afterEach(() => {
  process.env.KANBAN95_HOME = KH;
  rmSync(pointerPath(), { force: true });
  temps.splice(0).forEach(removeTemp);
});

describe('data folder pointer', () => {
  it('reads and writes settings, models.json, projects.json and the global brain under the folder the pointer names', async () => {
    const data = temp('k95-data-');
    mkdirSync(localHome(), { recursive: true });
    writeFileSync(pointerPath(), data + '\n');
    expect(boardHome()).toBe(data);

    writeConfig('settings', { zoom: 1.5 });
    expect(JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).zoom).toBe(1.5);
    expect(existsSync(join(localHome(), 'settings.json'))).toBe(false);
    writeFileSync(join(data, 'models.json'), JSON.stringify({ cli: 'claude', claude: { plan: { model: 'm-on-ssd' } } }));
    expect(runSettings(null, 'plan').model).toBe('m-on-ssd');
    expect(readConfig('settings').zoom).toBe(1.5);

    const repo = temp('k95-');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const srv = await start({ repo });
    try {
      expect(readProjects().map((p) => p.path)).toContain(normal(srv.board.repo));
      expect(existsSync(join(data, 'projects.json'))).toBe(true);
      expect(existsSync(join(data, 'brain.db'))).toBe(true);
      expect(existsSync(join(localHome(), 'brain.db'))).toBe(false);
      expect(existsSync(join(localHome(), 'projects.json'))).toBe(false);
      expect(worktreesRoot(repo).startsWith(join(localHome(), 'worktrees'))).toBe(true);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it('is ~/.kanban95 when there is no pointer file', () => {
    const { VITEST: _, KANBAN95_HOME: __, ...env } = process.env;
    const settings = pathToFileURL(resolve(import.meta.dirname, '../dist/settings.js')).href;
    const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(settings)}).then((m) => console.log(m.boardHome()))`], { env, encoding: 'utf8' });
    expect(existsSync(join(homedir(), '.kanban95', 'home'))).toBe(false);
    expect(out.trim()).toBe(join(homedir(), '.kanban95'));
  });

  it('ignores a pointer that is not an absolute path, and setup writes none for the local home', () => {
    mkdirSync(localHome(), { recursive: true });
    writeFileSync(pointerPath(), 'relative\dir\n');
    expect(boardHome()).toBe(localHome());
    setBoardHome(localHome());
    expect(existsSync(pointerPath())).toBe(false);
  });
});
