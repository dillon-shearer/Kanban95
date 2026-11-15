import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContext } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { dataHome, repoKey } from '../src/settings.ts';
import { DEFAULTS_DIR, initTemplates, render, TEMPLATES, unknownVar, type TemplateName } from '../src/templates.ts';

let repo: string;
let db: DatabaseSync;
const inboxRoot = () => join(dataHome(), 'inbox', repoKey(repo));

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  db = openDb(repo);
  initTemplates(repo);
});
afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(inboxRoot(), { recursive: true, force: true });
});

describe('inbox folder', () => {
  it('a ticket prompt names <data folder>/inbox/<repo key>/<ticket id>, created by the render and kept by the next one', () => {
    const t = Number(db.prepare("INSERT INTO tickets (title) VALUES ('t')").run().lastInsertRowid);
    const dir = join(inboxRoot(), String(t));
    expect(existsSync(dir)).toBe(false);
    expect(render(repo, 'execute', buildContext(db, repo, t, 'worker'))).toContain(`\`${dir}\``);
    expect(existsSync(dir)).toBe(true);
    writeFileSync(join(dir, 'report.md'), 'kept');
    render(repo, 'plan', buildContext(db, repo, t, 'worker'));
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toBe('kept');
  });

  it('a brainstorm prompt names an absolute session-<n> folder under the repo inbox and creates it; without a session there is none', () => {
    const dir = join(inboxRoot(), 'session-7');
    expect(render(repo, 'brainstorm', buildContext(db, repo, null, 'planner', { session: 7 }))).toContain(`\`${dir}\``);
    expect(existsSync(dir)).toBe(true);
    expect(buildContext(db, repo, null, 'planner').inbox).toBe('(none)');
  });

  it('every shipped template carries the same rule naming {{inbox}} and post_deliverable, and passes the unknown-variable check', () => {
    const rules = (Object.keys(TEMPLATES) as TemplateName[]).map((name) => {
      const text = readFileSync(join(DEFAULTS_DIR, `${name}.md`), 'utf8');
      expect(unknownVar(text), name).toBeNull();
      const line = text.split('\n').find((l) => l.includes('goes in `{{inbox}}` with a plain name'));
      expect(line, name).toBeDefined();
      return line!.replace(/^(- |\d+\. )/, '');
    });
    expect(new Set(rules).size).toBe(1);
    expect(rules[0]).toContain('`post_deliverable`');
    expect(rules[0]).toContain('not the worktree, the session folder, temp, the Desktop or the repo');
  });
});
