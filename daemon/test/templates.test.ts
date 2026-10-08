import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRAIN_TRUNCATED, brainFor, buildContext, startRun } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { DEFAULTS_DIR, initTemplates, render, TEMPLATES, VARS, type Ctx, type TemplateName } from '../src/templates.ts';

let repo: string;
let db: DatabaseSync;
const tpl = (name: string) => join(repo, '.kanban95', 'templates', `${name}.md`);
const ctx = Object.fromEntries(VARS.map((v) => [v, `<${v}>`])) as Ctx;
const brain = (title: string, body: string, tags = '') => db.prepare('INSERT INTO brain (title, body, tags) VALUES (?, ?, ?)').run(title, body, tags);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  db = openDb(repo);
  initTemplates(repo);
});
afterEach(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('templates', () => {
  it('copies the defaults on init and never overwrites an edited one; edits apply on the next render', () => {
    expect(readFileSync(tpl('test'), 'utf8')).toBe(readFileSync(join(DEFAULTS_DIR, 'test.md'), 'utf8'));
    writeFileSync(tpl('execute'), 'mine {{ticket}}');
    expect(render(repo, 'execute', ctx)).toBe('mine <ticket>');
    initTemplates(repo);
    expect(readFileSync(tpl('execute'), 'utf8')).toBe('mine {{ticket}}');
    writeFileSync(tpl('execute'), 'edited {{retry}}');
    expect(render(repo, 'execute', ctx)).toBe('edited <retry>');
  });

  it('refuses an unknown variable by name and template, even when ctx would supply it', () => {
    writeFileSync(tpl('execute'), 'ok {{ticket}} then {{ transcript }}');
    expect(() => render(repo, 'execute', { ...ctx, transcript: 'leak' } as Ctx)).toThrow('template execute.md uses unknown variable {{transcript}}');
  });

  it('refuses a template name outside the set', () => {
    expect(() => render(repo, '../board' as TemplateName, ctx)).toThrow('unknown template ../board');
  });

  it('every default renders with only known variables', () => {
    for (const name of Object.keys(TEMPLATES) as TemplateName[]) {
      expect(render(repo, name, ctx)).not.toMatch(/\{\{/);
    }
  });

  it('inserts values literally: a placeholder inside a value is not expanded', () => {
    writeFileSync(tpl('execute'), '{{brain}}|{{ticket}}');
    expect(render(repo, 'execute', { ...ctx, brain: '{{ticket}} {{transcript}} $&' })).toBe('{{ticket}} {{transcript}} $&|<ticket>');
  });
});

describe('context', () => {
  const ticket = (title: string, body = '', criteria = '') =>
    Number(db.prepare('INSERT INTO tickets (title, body, criteria) VALUES (?, ?, ?)').run(title, body, criteria).lastInsertRowid);
  const note = (t: number, kind: string, body: string, at: string) =>
    db.prepare('INSERT INTO notes (ticket_id, role, kind, body, created_at) VALUES (?, ?, ?, ?, ?)').run(t, 'tester', kind, body, at);
  const run = (t: number, phase: string, at: string) =>
    db.prepare("INSERT INTO runs (ticket_id, phase, cli, model, effort, prompt_rendered, started_at) VALUES (?, ?, 'c', 'm', 'medium', '', ?)").run(t, phase, at);

  it('brain: at most N entries, best match first, nothing unrelated', () => {
    for (let i = 0; i < 8; i++) brain(`websocket note ${i}`, 'about sockets');
    brain('unrelated', 'gardening');
    const best = Number(brain('websocket reconnect', 'websocket reconnect backoff websocket', 'websocket').lastInsertRowid);
    const out = brainFor(db, 'Fix websocket reconnect', 5);
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5);
    expect(out.startsWith(`- [#${best}] websocket reconnect: `)).toBe(true);
    expect(out).not.toContain('gardening');
  });

  it('brain: the character budget truncates and marks the cut', () => {
    brain('merge queue', 'x'.repeat(3000));
    brain('merge conflict', 'y'.repeat(3000));
    const out = brainFor(db, 'merge', 5, 1000);
    expect(out.length).toBe(1000);
    expect(out.endsWith(BRAIN_TRUNCATED)).toBe(true);
    expect(brainFor(db, 'merge', 5, 100_000)).not.toContain(BRAIN_TRUNCATED);
  });

  it('notes: only failures since the latest execute run, not earlier cycles or other kinds', () => {
    const t = ticket('retry me');
    run(t, 'execute', '2026-01-01T00:00:00.000Z');
    note(t, 'failure', 'old cycle failure', '2026-01-01T00:01:00.000Z');
    run(t, 'execute', '2026-01-01T00:02:00.000Z');
    note(t, 'failure', 'current failure\nline two', '2026-01-01T00:03:00.000Z');
    note(t, 'decision', 'not a failure', '2026-01-01T00:03:00.000Z');
    const { notes } = buildContext(db, t, 'worker');
    expect(notes).toBe('- [tester] current failure\n  line two');
  });

  it('same ticket and same db render byte-identically; values come from the ticket', () => {
    const t = ticket('Add retry backoff', 'Backoff for the retry loop.', '- waits double each time');
    brain('retry backoff', 'use jitter');
    brain('retry backoff', 'use jitter');
    const a = render(repo, 'execute', buildContext(db, t, 'worker'));
    const b = render(repo, 'execute', buildContext(db, t, 'worker'));
    expect(a).toBe(b);
    expect(a).toContain(`#${t} Add retry backoff\n\nBackoff for the retry loop.`);
    expect(a).toContain('- waits double each time');
    expect(a).toContain('- move_ticket (own → testing)');
    expect(a).not.toContain('report_test');
  });

  it('diff is empty outside the test phase and git diff base...HEAD inside it', () => {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
    git('checkout', '-q', '-b', 'ticket/1');
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    git('add', 'a.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add a');
    const t = ticket('diffed');
    expect(buildContext(db, t, 'worker').diff).toBe('');
    expect(buildContext(db, t, 'tester', { worktree: repo, base: 'main' }).diff).toMatch(/^diff --git a\/a\.txt[\s\S]*\+hello/);
    expect(() => buildContext(db, t, 'tester')).toThrow('worktree and base');
  });

  it('startRun stores the rendered prompt on a runs row before anything spawns; a bad template writes no row', () => {
    const t = ticket('run me');
    const r = startRun(db, repo, { ticketId: t, template: 'housekeeping', cli: 'claude', model: 'm', effort: 'low' });
    const row = db.prepare('SELECT phase, prompt_rendered FROM runs WHERE id = ?').get(r.id) as { phase: string; prompt_rendered: string };
    expect(row).toEqual({ phase: 'execute', prompt_rendered: r.prompt });
    writeFileSync(tpl('test'), '{{transcript}}');
    expect(() => startRun(db, repo, { ticketId: t, template: 'test', cli: 'c', model: 'm', effort: 'low', worktree: repo, base: 'x' })).toThrow('transcript');
    expect((db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n).toBe(1);
  });
});
