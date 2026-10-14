import './home.ts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { start } from '../src/server.ts';
import { DEFAULTS_DIR, initTemplates, replacedPath, shippedPath } from '../src/templates.ts';

let repo: string;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const tpl = (name: string) => join(repo, '.kanban95', 'templates', `${name}.md`);
const def = (name: string) => readFileSync(join(DEFAULTS_DIR, `${name}.md`), 'utf8');
const record = () => JSON.parse(readFileSync(shippedPath(repo), 'utf8'));

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe('template copies on daemon start', () => {
  it('replaces a copy an older daemon wrote with no record, records it, and keeps the old text once', async () => {
    const old = '# Test a ticket\n\nRun the full npm test. {{ticket}}\n';
    mkdirSync(join(repo, '.kanban95', 'templates'), { recursive: true });
    writeFileSync(tpl('test'), old);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const srv = await start({ repo });
    await srv.close();
    expect(readFileSync(tpl('test'), 'utf8')).toBe(def('test'));
    expect(record().test).toBe(sha(def('test')));
    expect(readFileSync(replacedPath(repo, 'test'), 'utf8')).toBe(old);
    expect(log.mock.calls.flat().join('\n')).toMatch(/test\.md .*replaced.*test\.replaced\.md/);
    expect(readFileSync(join(repo, '.kanban95', '.gitignore'), 'utf8')).toContain('templates/*.replaced.md');

    initTemplates(repo); // the next start: shown once, then gone
    expect(existsSync(replacedPath(repo, 'test'))).toBe(false);
    expect(readFileSync(tpl('test'), 'utf8')).toBe(def('test'));
  });

  it('replaces a copy that still matches its record and leaves one edited after its record alone', () => {
    initTemplates(repo);
    const older = 'older default {{ticket}}';
    writeFileSync(tpl('test'), older);
    writeFileSync(tpl('execute'), 'edited {{ticket}}');
    writeFileSync(shippedPath(repo), JSON.stringify({ ...record(), test: sha(older), execute: sha('an older default') }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    initTemplates(repo);
    expect(readFileSync(tpl('test'), 'utf8')).toBe(def('test'));
    expect(record().test).toBe(sha(def('test')));
    expect(readFileSync(tpl('execute'), 'utf8')).toBe('edited {{ticket}}');
    expect(record().execute).toBe(sha('an older default'));
    expect(existsSync(replacedPath(repo, 'test'))).toBe(false);
    expect(existsSync(replacedPath(repo, 'execute'))).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('commits the copies a start replaces, so the main checkout stays clean and tickets can launch', async () => {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Op');
    git('config', 'user.email', 'op@example.com');
    initTemplates(repo);
    const older = 'older default {{ticket}}';
    writeFileSync(tpl('test'), older);
    writeFileSync(shippedPath(repo), JSON.stringify({ ...record(), test: sha(older) }));
    writeFileSync(join(repo, 'staged.txt'), 'mine');
    git('add', '-A');
    git('commit', '-qm', 'Seed');
    writeFileSync(join(repo, 'staged.txt'), 'still mine');
    git('add', 'staged.txt');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const srv = await start({ repo });
    await srv.close();
    expect(readFileSync(tpl('test'), 'utf8')).toBe(def('test'));
    expect(git('log', '-1', '--format=%an %s')).toBe('Op Update the board prompt templates to the shipped defaults');
    expect(git('show', '--name-only', '--format=', 'HEAD').split(/\r?\n/).sort()).toEqual(['.kanban95/templates/.shipped.json', '.kanban95/templates/test.md']);
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('M  staged.txt');
  });
});
