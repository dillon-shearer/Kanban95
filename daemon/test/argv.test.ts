// The launcher's pure parts, with no daemon: the argv each CLI and role gets, and how the silence watch finds a transcript.
// Launching for real, on a fake CLI in a pty, is in launcher.test.ts.
import './home.ts'; // also here, not only in vitest.config.ts: a run from the repo root skips that config and wrote the real home
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '../src/grants.ts';
import { buildArgv, RESUME_MESSAGE, transcriptSize, type ArgvIn, type Cli, type Effort } from '../src/launcher.ts';
import { lastLines } from '../src/pty.ts';

describe('buildArgv', () => {
  const base = { repo: 'C:\\r', promptPath: 'C:/r/.kanban95/sessions/3/prompt.md', mcpConfigPath: 'C:/r/.kanban95/sessions/3/mcp.json', settingsPath: 'C:/r/.kanban95/sessions/3/settings.json', mcpUrl: 'http://127.0.0.1:5/mcp', wtRoot: 'C:\\k95\\worktrees\\r-0011aabb', cwd: 'C:/k95/worktrees/r-0011aabb/t-7' };
  // The absolute path: agents given the relative one resolved it against the home directory.
  const msg = `Read ${resolve(base.promptPath).replaceAll('\\', '/')} in full and follow it. It is your brief for this session.`;
  const claude = (model: string, effort: string, ...role: string[]) =>
    ['claude', '--mcp-config', base.mcpConfigPath, '--strict-mcp-config', ...(model ? ['--model', model] : []), '--effort', effort, ...role, '--dangerously-skip-permissions', msg];
  const codex = (model: string, effort: string, ...role: string[]) =>
    ['codex', ...(model ? ['--model', model] : []), '-c', `model_reasoning_effort=${effort}`, '-c', 'mcp_servers.kanban95.url=http://127.0.0.1:5/mcp',
      '-c', 'mcp_servers.kanban95.bearer_token_env_var=KANBAN95_TOKEN', '-c', 'mcp_servers.kanban95.default_tools_approval_mode=approve', '-c', "projects={'C:\\k95\\worktrees\\r-0011aabb'={trust_level='trusted'},'C:\\r'={trust_level='trusted'}}", ...role, msg];
  // Workers and testers drop the operator's user settings (plugin hooks) and skills; planner and operator sessions keep them.
  const lean = ['--setting-sources', 'project,local', '--settings', 'C:/r/.kanban95/sessions/3/settings.json', '--disable-slash-commands'];
  // Reach by role: a planner cannot write files; workers and testers run with permissions off.
  const rows: [Cli, Role, string, Effort, string[]][] = [
    ['claude', 'worker', 'claude-opus-5-5', 'low', claude('claude-opus-5-5', 'low', ...lean)],
    ['claude', 'tester', 'claude-sonnet-5-5', 'max', claude('claude-sonnet-5-5', 'max', ...lean)],
    ['claude', 'planner', 'claude-fable-5-1', 'high', claude('claude-fable-5-1', 'high', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent')],
    ['claude', 'operator', 'claude-opus-5-5', 'high', claude('claude-opus-5-5', 'high')],
    ['codex', 'worker', 'gpt-5.6-terra', 'medium', codex('gpt-5.6-terra', 'medium', '--dangerously-bypass-approvals-and-sandbox')],
    ['codex', 'tester', 'gpt-5.6-luna', 'max', codex('gpt-5.6-luna', 'max', '--dangerously-bypass-approvals-and-sandbox')],
    ['codex', 'planner', 'gpt-5.6-sol', 'high', codex('gpt-5.6-sol', 'high', '-s', 'read-only', '-a', 'never')],
    // An operator terminal with no operator row: no --model, the CLI's own default.
    ['claude', 'operator', '', 'medium', claude('', 'medium')],
    ['codex', 'operator', '', 'medium', codex('', 'medium', '--dangerously-bypass-approvals-and-sandbox')],
  ];
  it.each(rows)('%s %s %s %s', (cli, role, model, effort, want) => {
    expect(buildArgv({ ...base, cli, role, model, effort } as ArgvIn)).toEqual(want);
  });

  // A ticket's Claude session is named at launch and continued by that name; Codex has no such flag in use (ponytail in launcher.ts).
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  it('names a fresh Claude session with --session-id and continues a killed one with --resume and the one-line restart message', () => {
    const fresh = buildArgv({ ...base, cli: 'claude', role: 'worker', model: 'm', effort: 'low', sessionId: id });
    expect(fresh.slice(0, 6)).toEqual(['claude', '--mcp-config', base.mcpConfigPath, '--strict-mcp-config', '--session-id', id]);
    expect(fresh.at(-1)).toBe(msg);
    const resumed = buildArgv({ ...base, cli: 'claude', role: 'tester', model: 'm', effort: 'low', sessionId: id, resume: true });
    expect(resumed).toEqual(['claude', '--mcp-config', base.mcpConfigPath, '--strict-mcp-config', '--resume', id, '--model', 'm', '--effort', 'low', ...lean,
      '--dangerously-skip-permissions', RESUME_MESSAGE]);
    expect(RESUME_MESSAGE).not.toMatch(/["%\n]/); // it must cross cmd.exe
    expect(buildArgv({ ...base, cli: 'codex', role: 'worker', model: 'm', effort: 'low', sessionId: id, resume: true })).toEqual(codex('m', 'low', '--dangerously-bypass-approvals-and-sandbox'));
  });

  it('keeps the relative prompt path when the absolute one holds a character cmd.exe refuses', () => {
    const p = (s: string) => s.replace('C:/', 'C:/100%/');
    const argv = buildArgv({ ...base, promptPath: p(base.promptPath), cwd: p(base.cwd), cli: 'claude', role: 'worker', model: 'm', effort: 'low' });
    expect(argv.at(-1)).toBe('Read ../../../../r/.kanban95/sessions/3/prompt.md in full and follow it. It is your brief for this session.');
  });

  it('refuses a repo or worktrees root path Codex trust cannot quote', () => {
    expect(() => buildArgv({ ...base, repo: "C:\\o'brien", cli: 'codex', role: 'worker', model: 'm', effort: 'low' })).toThrow(/containing ' for Codex: C:\\o'brien$/);
    const wtRoot = "C:\\o'brien\\.kanban95\\worktrees\\r-0011aabb";
    expect(() => buildArgv({ ...base, wtRoot, cli: 'codex', role: 'worker', model: 'm', effort: 'low' })).toThrow(`containing ' for Codex: ${wtRoot}`);
  });
});

describe('transcripts, for the silence watch', () => {
  const day = (t: number) => { const d = new Date(t); return join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')); };
  const rollout = (name: string, cwd: string, extra = '') => {
    const dir = join(process.env.USERPROFILE!, '.codex', 'sessions', day(Date.now()));
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `rollout-${name}.jsonl`);
    writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id: name, cwd } }) + '\n' + extra);
    return f;
  };
  afterEach(() => rmSync(join(process.env.USERPROFILE!, '.codex'), { recursive: true, force: true }));

  it("Codex: the newest rollout written since the start whose cwd is the session's; another worktree's or an earlier run's is not", () => {
    const cwd = join(tmpdir(), 'k95-wt', 't-9');
    const started = Date.now();
    const old = rollout('2026-01-01T00-00-00-a', cwd, 'x'.repeat(50));
    utimesSync(old, new Date(started - 60_000), new Date(started - 60_000)); // the previous run in this worktree
    rollout('2026-01-01T00-00-02-c', join(tmpdir(), 'k95-wt', 't-10'), 'x'.repeat(70));
    const s = { cli: 'codex' as const, cwd, started };
    expect(transcriptSize(s)).toBe(-1);
    const mine = rollout('2026-01-01T00-00-01-b', process.platform === 'win32' ? cwd.toUpperCase() : cwd, 'line\n'); // Windows paths ignore case
    expect(transcriptSize(s)).toBe(readFileSync(mine).length);
  });

  it('Claude: the --session-id transcript under any project dir, -1 until it exists', () => {
    const s = { cli: 'claude' as const, cwd: tmpdir(), started: Date.now(), sessionId: '00000000-0000-4000-8000-000000000001' };
    expect(transcriptSize(s)).toBe(-1);
    const dir = join(process.env.USERPROFILE!, '.claude', 'projects', 'C--anything');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${s.sessionId}.jsonl`), '{}\n{}\n');
    expect(transcriptSize(s)).toBe(6);
    rmSync(join(process.env.USERPROFILE!, '.claude', 'projects'), { recursive: true, force: true });
  });

  it('lastLines: escape sequences gone, cursor moves and carriage returns as breaks, blanks and repeats dropped, only the last n', () => {
    const raw = '\x1b]0;title\x07one\r\n\x1b[2K\x1b[1;1Htwo\x1b[32m green\x1b[0m\x1b[3;1H\x1b[?25l\r\n\r\nthree\rthree\nfour';
    expect(lastLines(raw, 3)).toEqual(['two green', 'three', 'four']);
    expect(lastLines('', 5)).toEqual([]);
  });
});
