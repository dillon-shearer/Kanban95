// Launches an agent CLI on a ticket: worktree, run row, grant, session dir, argv, pty. Tears it all down on exit or revoke.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { IPty } from 'node-pty';
import { buildContext, startRun } from './context.js';
import { createWorktree } from './git.js';
import { mint, revoke, type Role } from './grants.js';
import { childEnv, spawnPty } from './pty.js';
import { fill, loadTemplate, TEMPLATES, type TicketTemplate } from './templates.js';
import { BadConfig, type Cli, type Effort } from './settings.js';
import { preTrustClaude } from './trust.js';

/** Codex reads the bearer token for the board's MCP server from this variable; it is set only in the CLI's own environment. */
const TOKEN_ENV = 'KANBAN95_TOKEN';
// ponytail: a grant outlives its session by at most 24 h; in practice teardown revokes it when the pty exits.
const GRANT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Claude Code tools a planner loses. The brainstorm template asks it to read code and write tickets over MCP, never to edit or
 * run anything; Read, Grep and Glob cover the reading. Bash and PowerShell go too, since either could write a file, and Agent,
 * since a subagent is a way around the list (the live check's agent named it).
 */
const PLANNER_DENY = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent'];

/** Workers and testers run without the operator at the keyboard; planner and operator sessions are interactive. */
const unattended = (role: Role) => role === 'worker' || role === 'tester';
const BOARD_SETTINGS = { attribution: { commit: '', pr: '' } };

export interface ArgvIn {
  cli: Cli;
  role: Role;
  /** The main repo root: Codex is told per process that it is trusted, which covers every worktree under it. */
  repo: string;
  model: string;
  effort: Effort;
  promptPath: string;
  /** Claude Code: the session's mcp.json (URL + bearer header). */
  mcpConfigPath: string;
  /** Claude Code, workers and testers: the board's own settings file, which replaces the operator's user settings. */
  settingsPath: string;
  /** Codex: the daemon's /mcp URL, passed as a per-process config override. */
  mcpUrl: string;
  cwd: string;
}

/**
 * The exact command line per CLI, flags verified against the installed `--help` (docs/CLIS.md).
 * The initial message points at prompt.md instead of carrying it: Windows caps a command line at 32 767 characters
 * (a test prompt holds the whole diff) and cmd.exe cannot pass a newline inside an argument.
 * Reach is limited by role, not by approvals: a planner cannot write files; workers, testers and the operator run with permissions off.
 */
export function buildArgv(a: ArgvIn): string[] {
  const message = `Read ${relative(a.cwd, a.promptPath).replaceAll('\\', '/')} in full and follow it. It is your brief for this session.`;
  const planner = a.role === 'planner';
  switch (a.cli) {
    case 'claude':
      // --mcp-config and --disallowedTools are variadic, so each is followed by another flag, never by the message.
      // An empty model (an operator terminal with no operator row in models.json) runs the CLI's own default model.
      // Workers and testers load no user settings, so none of the operator's plugin hooks, and no skills: none was invoked in
      // 113 measured runs, while the hooks and skill listing cost ~15k tokens on every call (ticket #43, operator approved).
      return ['claude', '--mcp-config', a.mcpConfigPath, '--strict-mcp-config', ...(a.model ? ['--model', a.model] : []), '--effort', a.effort,
        ...(planner ? ['--disallowedTools', ...PLANNER_DENY] : []),
        ...(unattended(a.role) ? ['--setting-sources', 'project,local', '--settings', a.settingsPath, '--disable-slash-commands'] : []),
        '--dangerously-skip-permissions', message];
    case 'codex': {
      // Unquoted -c values fail TOML parsing and are taken as literal strings, which keeps `"` out of the cmd.exe line.
      // The trust table is a TOML literal-string key, which cannot hold a single quote.
      if (a.repo.includes("'")) throw new Error(`cannot pre-trust a repo path containing ' for Codex: ${a.repo}`);
      // Workers and testers keep the bypass: under -s workspace-write Codex on Windows runs commands as a sandbox account
      // and git refuses the worktree ("dubious ownership"), so an agent could not commit (docs/CLIS.md).
      return ['codex', ...(a.model ? ['--model', a.model] : []), '-c', `model_reasoning_effort=${a.effort}`,
        '-c', `mcp_servers.kanban95.url=${a.mcpUrl}`, '-c', `mcp_servers.kanban95.bearer_token_env_var=${TOKEN_ENV}`,
        // The board's own tools are pre-approved (`approve`; `auto` still asks); the grant already scopes them. Without this a
        // planner under -a never is refused every MCP call ("requires approval, but approval policy is never"; checked live).
        '-c', 'mcp_servers.kanban95.default_tools_approval_mode=approve',
        '-c', `projects={'${a.repo}'={trust_level='trusted'}}`,
        ...(planner ? ['-s', 'read-only', '-a', 'never'] : ['--dangerously-bypass-approvals-and-sandbox']), message];
    }
  }
}

export interface Session {
  /** The key in `sessions` and in `/pty/<key>`: the run id, or minus the grant id for a brainstorm or operator terminal (no ticket, so no run). */
  key: number;
  runId: number | null;
  grantId: number;
  ticketId: number | null;
  role: Role;
  /** For the terminal title: the run's phase (`brainstorm` or `operator` for a session without a ticket) and model. */
  phase: string;
  model: string;
  /** Set by the lifecycle when it ends the session after the agent reported (a move_ticket); its exit is then expected. */
  outcome?: string;
  dir: string;
  pty: IPty;
  scrollback: () => string;
  /** Resolves once the run row is written, the grant revoked and the session dir gone. */
  done: Promise<void>;
}

/** Live sessions by key. */
export const sessions = new Map<number, Session>();
export const sessionsOf = (ticketId: number) => [...sessions.values()].filter((s) => s.ticketId === ticketId);

const sessionDir = (repo: string, key: number) => join(repo, '.kanban95', 'sessions', String(key));

/** Owner-only: mode 0700 on POSIX; on Windows inheritance is cut and only the current user is granted access. */
function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${userInfo().username}:(OI)(CI)F`], { stdio: 'ignore' });
  }
}

type Daemon = { db: DatabaseSync; repo: string; port: number; onExit?: (s: Session) => void };
/** `path`: the operator's configured executable for the CLI (Settings); the bare name, resolved through PATH, when unset. */
type RunSettings = { cli: Cli; model: string; effort: Effort; path?: string };

export function launch(d: Daemon, o: { ticketId: number; template: TicketTemplate } & RunSettings): Session {
  const wt = createWorktree(d.repo, o.ticketId);
  const run = startRun(d.db, d.repo, { ...o, worktree: wt.path, base: wt.base });
  return spawnSession(d, o, { runId: run.id, ticketId: o.ticketId, role: TEMPLATES[o.template].role, phase: TEMPLATES[o.template].phase, cwd: wt.path, prompt: run.prompt });
}

/**
 * A session in the repo root with no ticket, so no worktree and no run row: a brainstorm (planner, optionally seeded with the
 * operator's text) or an operator terminal (the operator's typed mission). Its grant has no ticket and is revoked when the pty exits.
 */
export function launchRoot(d: Daemon, o: RunSettings & { template: 'brainstorm' | 'operator'; mission?: string }): Session {
  const { role } = TEMPLATES[o.template];
  const ctx = buildContext(d.db, d.repo, null, role);
  const text = loadTemplate(d.repo, o.template);
  // A repo copy older than the {{mission}} slot would drop the operator's text without a word.
  if (o.mission && !/\{\{\s*mission\s*\}\}/.test(text)) throw new BadConfig(`${o.template}.md has no {{mission}}: reset it in Settings → Templates`);
  if (o.mission) ctx.mission = o.mission;
  const prompt = fill(text, ctx);
  return spawnSession(d, o, { runId: null, ticketId: null, role, phase: o.template, cwd: d.repo, prompt });
}

function spawnSession(d: Daemon, o: RunSettings, r: { runId: number | null; ticketId: number | null; role: Role; phase: string; cwd: string; prompt: string }): Session {
  const { db, repo } = d;
  const grant = mint(db, { ticket: r.ticketId, role: r.role, ttlMs: GRANT_TTL_MS });
  const key = r.runId ?? -grant.id;
  const dir = sessionDir(repo, key);
  const teardown = (scrollback: string | null) => {
    try {
      if (r.runId !== null) db.prepare("UPDATE runs SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), scrollback = ? WHERE id = ?").run(scrollback, r.runId);
      revoke(db, grant.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  try {
    const mcpUrl = `http://127.0.0.1:${d.port}/mcp`;
    // Owner-only when the dir holds a bearer (Claude Code's mcp.json). A Codex session keeps its token in the pty env and
    // its dir holds only prompt.md, which its read-only sandbox (another Windows account) must be able to read.
    if (o.cli === 'claude') privateDir(dir);
    else mkdirSync(dir, { recursive: true });
    const promptPath = join(dir, 'prompt.md');
    const mcpConfigPath = join(dir, 'mcp.json');
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(promptPath, r.prompt, { mode: o.cli === 'claude' ? 0o600 : 0o644 });
    if (o.cli === 'claude') {
      const cfg = { mcpServers: { kanban95: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${grant.token}` } } } };
      writeFileSync(mcpConfigPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      // No commit or PR trailer (CLAUDE.md), held by the board now that the operator's own attribution setting is not loaded.
      if (unattended(r.role)) writeFileSync(settingsPath, JSON.stringify(BOARD_SETTINGS), { mode: 0o600 });
    }
    const [cmd, ...args] = buildArgv({ ...o, role: r.role, repo: resolve(repo), promptPath, mcpConfigPath, settingsPath, mcpUrl, cwd: r.cwd });
    if (o.cli === 'claude') preTrustClaude(db, r.ticketId, repo);
    // KANBAN95_AGENT makes `npm run dev` and Kanban95.cmd refuse to start: an agent must not open the board on the operator's desktop.
    // A 5 min cache TTL writes at 1.25x instead of the subscription's 1 h at 2x; an unattended session rarely idles 5 min
    // (8 of 2,161 measured call gaps). Interactive sessions keep the 1 h TTL, since they wait on the operator.
    const env = childEnv({
      KANBAN95_AGENT: '1',
      ...(o.cli === 'codex' ? { [TOKEN_ENV]: grant.token } : {}),
      ...(o.cli === 'claude' && unattended(r.role) ? { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } : {}),
    });
    const { pty, scrollback } = spawnPty(o.path || cmd, args, { cwd: r.cwd, env });

    let finished!: () => void;
    const s: Session = {
      key, runId: r.runId, grantId: grant.id, ticketId: r.ticketId, role: r.role, phase: r.phase, model: o.model, dir, pty, scrollback,
      done: new Promise((ok) => (finished = ok)),
    };
    sessions.set(key, s);
    pty.onExit(() => {
      sessions.delete(key);
      try {
        teardown(scrollback());
        d.onExit?.(s);
      } catch (e) {
        console.error('[launcher]', e); // an exit handler that throws must not leave `done` pending
      } finally {
        finished();
      }
    });
    return s;
  } catch (e) {
    teardown(null);
    throw e;
  }
}

/** Revoking a grant ends its session: the pty is killed and its exit handler tears the rest down. */
export function killGrantSession(grantId: number) {
  for (const s of sessions.values()) if (s.grantId === grantId) s.pty.kill();
}

/** Daemon shutdown: kill every pty and wait until each session has written its run row and removed its dir. */
export async function killAll() {
  const live = [...sessions.values()];
  for (const s of live) s.pty.kill();
  await Promise.all(live.map((s) => s.done));
}
