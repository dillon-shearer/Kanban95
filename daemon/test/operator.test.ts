// The operator terminal: its grant (schema, MCP reach, expiry), its argv, its template and POST /api/operator.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/context.ts';
import { MIGRATIONS_DIR, migrate } from '../src/db.ts';
import { mint, verify } from '../src/grants.ts';
import { buildArgv, sessions, type ArgvIn, type Session } from '../src/launcher.ts';
import { start } from '../src/server.ts';
import { fill, loadTemplate, render, VARS, type Ctx } from '../src/templates.ts';

// Fake `claude` first on PATH: it says it is up, then stays up until the board kills it.
const bin = mkdtempSync(join(tmpdir(), 'k95-bin-'));
const PATH0 = process.env.PATH;
let repo: string;
let srv: Awaited<ReturnType<typeof start>>;
let op: Client;

const ticket = (title: string, status = 'backlog') => Number(srv.db.prepare('INSERT INTO tickets (title, status) VALUES (?, ?)').run(title, status).lastInsertRowid);
const row = (id: number) => srv.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown>;
const post = (path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `k95=${srv.secret}` }, body: JSON.stringify(body) });
/** Killing a pty before its process is up can leave the exit unreported on Windows, so wait for the fake first. */
async function end(s: Session) {
  const t0 = Date.now();
  while (!s.scrollback().includes('FAKE UP')) {
    if (Date.now() - t0 > 5000) throw new Error('fake never came up');
    await new Promise((r) => setTimeout(r, 25));
  }
  s.pty.kill();
  await s.done;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await op.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { refused: r.isError === true, text: r.content[0].text };
}

beforeAll(async () => {
  writeFileSync(join(bin, 'fake.mjs'), "console.log('FAKE UP');\nprocess.stdin.resume();\n");
  writeFileSync(join(bin, 'claude.cmd'), `@node "%~dp0fake.mjs" %*\r\n`);
  process.env.PATH = bin + delimiter + PATH0;
  // Only a plan model: a ticket agent the operator launches fails to start and flags its ticket, which is all these tests need.
  mkdirSync(join(process.env.USERPROFILE!, '.kanban95'), { recursive: true });
  writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({ cli: 'claude', claude: { plan: { model: 'plan-m', effort: 'low' } } }));
  repo = mkdtempSync(join(tmpdir(), 'k95-'));
  srv = await start({ repo });
  op = new Client({ name: 'test', version: '0' });
  const { token } = mint(srv.db, { ticket: null, role: 'operator', ttlMs: 60_000 });
  await op.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
});
afterAll(async () => {
  await op.close();
  await srv.close();
  process.env.PATH = PATH0;
  rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
  rmSync(bin, { recursive: true, force: true });
});

describe('operator grant schema', () => {
  it('migration 004 lets an operator grant exist only without a ticket and keeps every audit row linked to its grant', () => {
    const old = mkdtempSync(join(tmpdir(), 'k95-mig-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '004')) copyFileSync(join(MIGRATIONS_DIR, f), join(old, f));
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, old);
    db.prepare("INSERT INTO tickets (title) VALUES ('a')").run();
    db.prepare("INSERT INTO grants (token_hash, ticket_id, role, expires_at) VALUES ('h1', 1, 'worker', '2999-01-01')").run();
    db.prepare("INSERT INTO audit (grant_id, ticket_id, tool, outcome) VALUES (1, 1, 'add_note', 'ok')").run();
    expect(() => db.prepare("INSERT INTO grants (token_hash, ticket_id, role, expires_at) VALUES ('h2', NULL, 'operator', '2999-01-01')").run()).toThrow(/CHECK/);

    expect(migrate(db, MIGRATIONS_DIR)[0]).toBe('004-operator-grants.sql'); // later migrations follow it
    expect(db.prepare('SELECT grant_id FROM audit').get()).toEqual({ grant_id: 1 });
    const ins = db.prepare("INSERT INTO grants (token_hash, ticket_id, role, expires_at) VALUES (?, ?, 'operator', '2999-01-01')");
    expect(() => ins.run('h3', 1)).toThrow(/CHECK/);
    expect(() => ins.run('h4', null)).not.toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
    rmSync(old, { recursive: true, force: true });
  });
});

describe('operator over MCP', () => {
  it('edits, notes and re-models any ticket and reads the whole board', async () => {
    const a = ticket('a');
    const b = ticket('b');
    expect((await call('update_ticket', { ticket_id: a, title: 'renamed', criteria: 'c' })).refused).toBe(false);
    expect(row(a)).toMatchObject({ title: 'renamed', criteria: 'c' });
    expect((await call('set_model', { ticket_id: b, model: 'big', effort: 'high' })).refused).toBe(false);
    expect(row(b)).toMatchObject({ model: 'big', effort: 'high' });
    expect((await call('add_note', { ticket_id: b, kind: 'decision', body: 'chose x' })).refused).toBe(false);
    expect(srv.db.prepare('SELECT role FROM notes WHERE ticket_id = ?').get(b)).toEqual({ role: 'operator' });
    expect(JSON.parse((await call('get_ticket', { ticket_id: a })).text).title).toBe('renamed');
    expect(JSON.parse((await call('list_tickets')).text).map((t: { id: number }) => t.id)).toEqual(expect.arrayContaining([a, b]));
  });

  it('moves any ticket through the lifecycle: launch, submit and fail, but cannot pass one the tester has not', async () => {
    const a = ticket('launch me');
    expect((await call('move_ticket', { ticket_id: a, status: 'in_progress' })).refused).toBe(false);
    expect(row(a).status).toBe('in_progress'); // launched; the agent could not start here, so it is flagged
    const b = ticket('submit me', 'in_progress');
    expect((await call('move_ticket', { ticket_id: b, status: 'testing' })).refused).toBe(false);
    expect(row(b).status).toBe('testing');
    const c = ticket('fail me', 'testing');
    expect((await call('move_ticket', { ticket_id: c, status: 'in_progress' })).refused).toBe(false);
    expect(row(c)).toMatchObject({ status: 'in_progress', retry: 1 });
    const d = ticket('pass me', 'testing');
    expect(await call('move_ticket', { ticket_id: d, status: 'done' })).toEqual({ refused: true, text: expect.stringMatching(/report_test/) });
    expect(row(d).status).toBe('testing');
  });

  it('is refused report_test, and every ticket tool needs ticket_id', async () => {
    const a = ticket('a', 'testing');
    expect(await call('report_test', { ticket_id: a, passed: true, summary: 'fine' })).toEqual({ refused: true, text: 'an operator may not call report_test' });
    expect(srv.db.prepare("SELECT outcome FROM audit WHERE tool = 'report_test' ORDER BY id DESC").get()).toEqual({ outcome: 'denied' });
    for (const [tool, args] of [['update_ticket', { title: 'x' }], ['move_ticket', { status: 'testing' }], ['add_note', { kind: 'plan', body: 'x' }], ['get_ticket', {}]] as const) {
      expect(await call(tool, args), tool).toEqual({ refused: true, text: 'ticket_id is required for an operator grant' });
    }
  });
});

describe('operator argv', () => {
  const base = { repo: 'C:\\r', promptPath: 'C:/r/.kanban95/sessions/-3/prompt.md', mcpConfigPath: 'C:/r/.kanban95/sessions/-3/mcp.json', settingsPath: 'C:/r/.kanban95/sessions/-3/settings.json', mcpUrl: 'http://127.0.0.1:5/mcp', cwd: 'C:/r', model: 'm', effort: 'high' };
  it.each(['claude', 'codex'])("%s: the worker's permissions, not the planner deny list", (cli) => {
    const argv = buildArgv({ ...base, cli, role: 'operator' } as ArgvIn);
    // The operator watches its terminal, so it keeps its own Claude settings and skills, which an unattended worker drops.
    const lean = ['--setting-sources', 'project,local', '--settings', base.settingsPath, '--disable-slash-commands'];
    expect(argv).toEqual(buildArgv({ ...base, cli, role: 'worker' } as ArgvIn).filter((a) => !lean.includes(a)));
    expect(argv).not.toEqual(buildArgv({ ...base, cli, role: 'planner' } as ArgvIn));
    expect(argv).toContain(cli === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('operator template', () => {
  it('renders {{mission}} verbatim, and refuses a context without it', () => {
    const ctx = buildContext(srv.db, repo, null, 'operator');
    const out = render(repo, 'operator', { ...ctx, mission: 'Fix the {{ticket}} parser & $1' });
    expect(out).toContain('## Mission\n\nFix the {{ticket}} parser & $1\n');
    expect(out).toContain('- report_cleanup (any)');
    expect(out).not.toContain('report_test');
    const { mission: _, ...without } = ctx;
    expect(() => fill(loadTemplate(repo, 'operator'), without as Ctx)).toThrow('no value for {{mission}}');
    expect(VARS).toContain('mission');
  });

  it('an unknown variable still fails', () => {
    writeFileSync(join(repo, '.kanban95', 'templates', 'operator.md'), '{{mission}} {{goal}}');
    try {
      expect(() => loadTemplate(repo, 'operator')).toThrow('template operator.md uses unknown variable {{goal}}');
    } finally {
      copyFileSync(join(import.meta.dirname, '../../templates/operator.md'), join(repo, '.kanban95', 'templates', 'operator.md'));
    }
  });
});

describe('POST /api/operator', () => {
  const lastAudit = () => srv.db.prepare("SELECT outcome, args_summary FROM audit WHERE tool = 'operator.launch' ORDER BY id DESC").get();

  it('refuses a missing, empty or blank mission, audited, and spawns nothing', async () => {
    for (const body of [{}, { mission: '' }, { mission: ' \n ' }, { mission: 3 }]) {
      const r = await post('/operator', body);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'mission must be a non-empty string' });
      expect(lastAudit()).toMatchObject({ outcome: 'error' });
    }
    expect(sessions.size).toBe(0);
  });

  it('spawns a session in the repo root whose brief holds the mission verbatim; its grant dies with it', async () => {
    const mission = 'Tidy the janitor.\nKeep "quotes" & {{brain}} as typed.';
    const r = await post('/operator', { mission });
    expect(r.status).toBe(201);
    const view = await r.json();
    expect(view).toMatchObject({ ticket_id: null, run_id: null, role: 'operator', phase: 'operator', model: '' }); // no operator row: the CLI's default model, no --model flag
    expect(lastAudit()).toMatchObject({ outcome: 'ok' });
    const s = sessions.get(view.id)!;
    expect(s.dir).toBe(join(repo, '.kanban95', 'sessions', String(view.id)));
    expect(readFileSync(join(s.dir, 'prompt.md'), 'utf8')).toContain(`## Mission\n\n${mission}\n`);
    expect(srv.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });

    const token = /^Bearer (.+)$/.exec(JSON.parse(readFileSync(join(s.dir, 'mcp.json'), 'utf8')).mcpServers.kanban95.headers.Authorization)![1];
    expect(verify(srv.db, token)).toMatchObject({ role: 'operator', ticket_id: null });
    await end(s);
    expect(verify(srv.db, token)).toBeNull();
    expect(existsSync(s.dir)).toBe(false);
  });

  it('runs with the operator row of models.json when set, the CLI default (no --model) when not', async () => {
    const file = join(process.env.USERPROFILE!, '.kanban95', 'models.json'), saved = readFileSync(file, 'utf8');
    try {
      writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), claude: { ...JSON.parse(saved).claude, operator: { model: 'row-m', effort: 'low' } } }));
      const view = await (await post('/operator', { mission: 'go' })).json();
      expect(view.model).toBe('row-m');
      await end(sessions.get(view.id)!);
    } finally {
      writeFileSync(file, saved);
    }
  });

  it('runs with .kanban95/config.json operator model and effort when set, and refuses a bad one', async () => {
    const cfg = join(repo, '.kanban95', 'config.json');
    try {
      writeFileSync(cfg, JSON.stringify({ operator: { model: 'op-m', effort: 'max' } }));
      const view = await (await post('/operator', { mission: 'go' })).json();
      expect(view.model).toBe('op-m');
      await end(sessions.get(view.id)!);
      writeFileSync(cfg, JSON.stringify({ operator: { effort: 'huge' } }));
      const r = await post('/operator', { mission: 'go' });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/operator\.effort must be one of/);
    } finally {
      rmSync(cfg, { force: true });
    }
  });
});

describe('POST /api/brainstorm', () => {
  const prompt = (view: { id: number }) => readFileSync(join(sessions.get(view.id)!.dir, 'prompt.md'), 'utf8');

  it("puts the operator's draft in the planner's brief verbatim, and (none) when there is none", async () => {
    expect((await post('/brainstorm', { mission: 3 })).status).toBe(400);
    const notes = 'Login keeps failing.\nKeep {{brain}} & $1 as typed.';
    const seeded = await (await post('/brainstorm', { mission: notes })).json();
    expect(prompt(seeded)).toContain(`## Starting notes\n\n${notes}\n`);
    await end(sessions.get(seeded.id)!);
    const blank = await (await post('/brainstorm', { mission: ' \n ' })).json();
    expect(prompt(blank)).toContain('## Starting notes\n\n(none)\n');
    await end(sessions.get(blank.id)!);
  });

  it('refuses a draft when the repo template has no {{mission}} rather than drop it, and still runs without one', async () => {
    const file = join(repo, '.kanban95', 'templates', 'brainstorm.md'), saved = readFileSync(file, 'utf8');
    try {
      writeFileSync(file, '# Brainstorm\n\n{{tools}}\n');
      const r = await post('/brainstorm', { mission: 'go' });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/brainstorm\.md has no \{\{mission\}\}: reset it in Settings → Prompts$/);
      expect(sessions.size).toBe(0);
      const view = await (await post('/brainstorm', {})).json();
      await end(sessions.get(view.id)!);
    } finally {
      writeFileSync(file, saved);
    }
  });
});
