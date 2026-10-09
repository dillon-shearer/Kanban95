import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRAIN_TRUNCATED, brainFor, buildContext, gitDiff, startRun } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { preferencesPath } from '../src/settings.ts';
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

  it('brain: bodies for the top two only, an index line with tags for the rest', () => {
    const ids = ['first', 'second', 'third'].map((n) => Number(brain(`queue ${n}`, `${n} body`, `queue ${n}tag`).lastInsertRowid));
    expect(brainFor(db, 'queue', 5).split('\n')).toEqual([
      `- [#${ids[0]}] queue first: first body`,
      `- [#${ids[1]}] queue second: second body`,
      `- [#${ids[2]}] queue third · queue thirdtag`,
    ]);
  });

  it('brain: a body over the budget falls back to its index line, never a partial body', () => {
    const a = Number(brain('merge queue', 'x'.repeat(3000)).lastInsertRowid);
    const b = Number(brain('merge conflict', 'y'.repeat(3000)).lastInsertRowid);
    expect(brainFor(db, 'merge', 5, 1000)).toBe(`- [#${a}] merge queue\n- [#${b}] merge conflict`);
    expect(brainFor(db, 'merge', 5, 100_000)).toContain('y'.repeat(3000));
  });

  it('brain: the budget cuts between rows and marks the cut', () => {
    for (let i = 0; i < 8; i++) brain(`cache entry ${i} ${'t'.repeat(60)}`, 'b', 'cache');
    const out = brainFor(db, 'cache', 8, 400);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith(BRAIN_TRUNCATED)).toBe(true);
    const rows = out.slice(0, -BRAIN_TRUNCATED.length).split('\n');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(8);
    for (const r of rows) expect(r).toMatch(/^- \[#\d+\] cache entry \d t{60}(: b| · cache)$/);
  });

  it('brain: a title hit outranks the same word repeated in a body', () => {
    brain('misc', 'socket '.repeat(4) + 'filler '.repeat(40));
    const titled = Number(brain('socket close', 'filler '.repeat(40)).lastInsertRowid);
    expect(brainFor(db, 'socket', 5).startsWith(`- [#${titled}] socket close: `)).toBe(true);
  });

  it('notes: only failures since the latest execute run, not earlier cycles or other kinds', () => {
    const t = ticket('retry me');
    run(t, 'execute', '2026-01-01T00:00:00.000Z');
    note(t, 'failure', 'old cycle failure', '2026-01-01T00:01:00.000Z');
    run(t, 'execute', '2026-01-01T00:02:00.000Z');
    note(t, 'failure', 'current failure\nline two', '2026-01-01T00:03:00.000Z');
    note(t, 'decision', 'not a failure', '2026-01-01T00:03:00.000Z');
    const { notes } = buildContext(db, repo, t, 'worker');
    expect(notes).toBe('- [tester] current failure\n  line two');
  });

  it('same ticket and same db render byte-identically; values come from the ticket', () => {
    const t = ticket('Add retry backoff', 'Backoff for the retry loop.', '- waits double each time');
    brain('retry backoff', 'use jitter');
    brain('retry backoff', 'use jitter');
    const a = render(repo, 'execute', buildContext(db, repo, t, 'worker'));
    const b = render(repo, 'execute', buildContext(db, repo, t, 'worker'));
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
    expect(buildContext(db, repo, t, 'worker').diff).toBe('');
    expect(buildContext(db, repo, t, 'tester', { worktree: repo, base: 'main' }).diff).toMatch(/^a\.txt \| 1 \+[\s\S]*\ndiff --git a\/a\.txt[\s\S]*\+hello/);
    expect(() => buildContext(db, repo, t, 'tester')).toThrow('worktree and base');
  });

  describe('gitDiff', () => {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    const commit = (files: Record<string, string>) => {
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, f)), { recursive: true });
        writeFileSync(join(repo, f), body);
      }
      git('add', ...Object.keys(files));
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'change');
    };
    beforeEach(() => {
      git('init', '-q', '-b', 'main');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
      git('checkout', '-q', '-b', 'ticket/1');
    });

    it('names markdown, docs and lockfiles in the stat but leaves their hunks out', () => {
      commit({ 'src/a.ts': 'code\n', 'README.md': 'readme words\n', 'docs/img/x.svg': '<svg/>\n', 'package-lock.json': '{}\n', 'shell/Cargo.lock': 'lock\n' });
      const d = gitDiff(repo, 'main');
      for (const f of ['src/a.ts', 'README.md', 'docs/img/x.svg', 'package-lock.json', 'shell/Cargo.lock']) expect(d).toContain(` ${f} `);
      expect(d).toContain('diff --git a/src/a.ts');
      expect(d.match(/^diff --git/gm)).toHaveLength(1);
      expect(d).not.toContain('readme words');
    });

    it('cuts a long diff at the budget with a marker naming how to pull the rest', () => {
      commit({ 'a.ts': 'x'.repeat(5000) + '\n' });
      const d = gitDiff(repo, 'main', 1000);
      expect(d).toMatch(/\n\[diff truncated: run git diff main\.\.\.HEAD -- <path>\]$/);
      expect(d.length).toBeLessThan(1000 + 200); // budget plus the stat
      expect(gitDiff(repo, 'main')).not.toContain('[diff truncated');
    });

    it('is empty when nothing changed, and a docs-only change still shows its stat', () => {
      expect(gitDiff(repo, 'main')).toBe('');
      commit({ 'docs/X.md': 'doc\n' });
      expect(gitDiff(repo, 'main')).toMatch(/^ docs\/X\.md \| 1 \+\n 1 file changed, 1 insertion\(\+\)$/);
    });
  });

  it('ticket lists each attachment by absolute path, and nothing when there are none', () => {
    const t = ticket('with a screenshot', 'See the picture.');
    expect(buildContext(db, repo, t, 'worker').ticket).toBe(`#${t} with a screenshot

See the picture.`);
    const dir = join(repo, '.kanban95', 'attachments', String(t));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'b.png'), 'x');
    writeFileSync(join(dir, 'a.log'), 'x');
    const { prompt } = startRun(db, repo, { ticketId: t, template: 'execute', cli: 'claude', model: 'm', effort: 'low' });
    expect(prompt).toContain(`See the picture.

Attachments (open with your file reader):
- ${join(dir, 'a.log')}
- ${join(dir, 'b.png')}`);
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

describe('operator preferences', () => {
  afterEach(() => rmSync(preferencesPath(), { force: true }));
  const ticket = () => Number(db.prepare("INSERT INTO tickets (title) VALUES ('t')").run().lastInsertRowid);

  it('every default template injects them under their own heading, ticket runs and brainstorms alike', () => {
    mkdirSync(dirname(preferencesPath()), { recursive: true });
    writeFileSync(preferencesPath(), 'no em dashes\n');
    const t = ticket();
    for (const name of Object.keys(TEMPLATES) as TemplateName[]) {
      const out = render(repo, name, name === 'brainstorm' ? buildContext(db, repo, null, 'planner') : buildContext(db, repo, t, 'worker'));
      expect(out, name).toContain('## Operator preferences\n\nno em dashes\n');
    }
  });

  it('a missing file renders (none)', () => {
    expect(render(repo, 'execute', buildContext(db, repo, ticket(), 'worker'))).toContain('## Operator preferences\n\n(none)\n');
    expect(render(repo, 'brainstorm', buildContext(db, repo, null, 'planner'))).toContain('## Operator preferences\n\n(none)\n');
  });
});

describe('brainstorm brief', () => {
  it('interviews in the terminal and does not offer ask_operator', () => {
    const out = render(repo, 'brainstorm', buildContext(db, repo, null, 'planner'));
    const tools = out.slice(out.indexOf('## Tools you may call'));
    expect(tools).toContain('create_ticket');
    expect(tools).not.toContain('ask_operator');
    expect(out).toMatch(/Interview the operator in this terminal/);
    expect(out).toMatch(/wait for the reply/);
  });
});
