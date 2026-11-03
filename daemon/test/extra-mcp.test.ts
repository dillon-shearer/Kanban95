import './home.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { operatorMcpServers } from '../src/extra-mcp.ts';
import { worktreePath } from '../src/git.ts';
import { start } from '../src/server.ts';
import { BadConfig, writeConfig } from '../src/settings.ts';
import { claudeKey } from '../src/trust.ts';
import { fakeCli } from './fake-cli.ts';
import { removeTemp } from './home.ts';

const state = join(homedir(), '.claude.json');
const figma = { type: 'http', url: 'https://mcp.figma.com/mcp' };
let repo: string;
let wt: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'k95-xmcp-'));
  wt = join(repo, 'wt', 't-1');
  mkdirSync(wt, { recursive: true });
});
afterEach(() => {
  rmSync(state, { force: true });
  removeTemp(repo);
});

describe('operatorMcpServers', () => {
  it('reads nothing when no server is named', () => {
    writeFileSync(state, '{ not json');
    expect(operatorMcpServers([], wt, repo)).toEqual({});
  });

  it('copies a server added in local scope on a folder above the worktree, as claude mcp add writes it', () => {
    const key = claudeKey(repo);
    const typed = process.platform === 'win32' ? key[0].toLowerCase() + key.slice(1) : key;
    writeFileSync(state, JSON.stringify({ mcpServers: { figma: { type: 'http', url: 'https://user.example/mcp' } }, projects: { [typed]: { mcpServers: { figma } } } }));
    expect(operatorMcpServers(['figma'], wt, repo)).toEqual({ figma });
  });

  it('falls back to the worktree .mcp.json, then the user scope', () => {
    const tool = { type: 'stdio', command: 'tool' };
    writeFileSync(join(wt, '.mcp.json'), JSON.stringify({ mcpServers: { tool } }));
    writeFileSync(state, JSON.stringify({ mcpServers: { figma, tool: { type: 'stdio', command: 'other' } } }));
    expect(operatorMcpServers(['tool', 'figma'], wt, repo)).toEqual({ tool, figma });
  });

  it('refuses a name the operator config does not hold', () => {
    writeFileSync(state, JSON.stringify({ mcpServers: { figma } }));
    expect(() => operatorMcpServers(['figma', 'missing'], wt, repo)).toThrow(BadConfig);
    expect(() => operatorMcpServers(['figma', 'missing'], wt, repo)).toThrow(/"missing"/);
  });
});

it('settings.json refuses kanban95 as an extra server, since the board server cannot be replaced', () => {
  expect(() => writeConfig('settings', { mcp_servers: ['kanban95'] })).toThrow(BadConfig);
  expect(writeConfig('settings', { mcp_servers: ['figma'] }).mcp_servers).toEqual(['figma']);
});

describe('a Claude launch with mcp_servers set', () => {
  const bin = mkdtempSync(join(tmpdir(), 'k95-xmcp-bin-'));
  const PATH0 = process.env.PATH;
  let srv: Awaited<ReturnType<typeof start>>;
  let board: string;

  beforeAll(() => {
    writeFileSync(join(bin, 'fake.mjs'), "import { copyFileSync } from 'node:fs';\nconst a = process.argv.slice(2);\ncopyFileSync(a[a.indexOf('--mcp-config') + 1], 'seen-mcp.json');\n");
    fakeCli(bin, 'claude', 'fake.mjs');
    process.env.PATH = bin + delimiter + PATH0;
  });
  afterAll(() => {
    process.env.PATH = PATH0;
    removeTemp(bin);
  });
  beforeEach(async () => {
    board = mkdtempSync(join(tmpdir(), 'k95-xmcp-repo-'));
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: board });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(board, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');
    srv = await start({ repo: board });
    srv.db.prepare("INSERT INTO tickets (id, title, body, criteria) VALUES (7, 't', 'b', 'c')").run();
  });
  afterEach(async () => {
    await srv.close();
    writeConfig('settings', {});
    removeTemp(board);
  });

  it('writes the named server next to the board server in the session mcp.json', async () => {
    writeFileSync(state, JSON.stringify({ mcpServers: { figma, other: { type: 'stdio', command: 'x' } } }));
    writeConfig('settings', { mcp_servers: ['figma'] });
    const s = srv.launch({ ticketId: 7, template: 'execute', cli: 'claude', model: 'm', effort: 'low' });
    await s.done;
    const seen = JSON.parse(readFileSync(join(worktreePath(board, 7), 'seen-mcp.json'), 'utf8')).mcpServers;
    expect(Object.keys(seen).sort()).toEqual(['figma', 'kanban95']);
    expect(seen.figma).toEqual(figma);
    expect(seen.kanban95.url).toBe(`http://127.0.0.1:${srv.port}/mcp`);
  });

  it('refuses the launch when a named server is missing, leaving no live grant or session dir', () => {
    writeFileSync(state, JSON.stringify({}));
    writeConfig('settings', { mcp_servers: ['figma'] });
    expect(() => srv.launch({ ticketId: 7, template: 'execute', cli: 'claude', model: 'm', effort: 'low' })).toThrow(BadConfig);
    expect(srv.db.prepare('SELECT COUNT(*) AS n FROM grants WHERE revoked_at IS NULL').get()).toEqual({ n: 0 });
    expect(existsSync(join(board, '.kanban95', 'sessions')) ? readdirSync(join(board, '.kanban95', 'sessions')) : []).toEqual([]);
  });
});
