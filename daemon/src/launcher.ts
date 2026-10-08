// Launches an agent CLI on a ticket: worktree, run row, grant, session dir, argv, pty. Tears it all down on exit or revoke.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { IPty } from 'node-pty';
import { startRun } from './context.js';
import { createWorktree } from './git.js';
import { mint, revoke } from './grants.js';
import { childEnv, spawnPty } from './pty.js';
import { TEMPLATES, type TemplateName } from './templates.js';

export const CLIS = ['claude', 'codex'] as const;
export type Cli = (typeof CLIS)[number];
export type Effort = 'low' | 'medium' | 'high' | 'max';
/** Codex reads the bearer token for the board's MCP server from this variable; it is set only in the CLI's own environment. */
export const TOKEN_ENV = 'KANBAN95_TOKEN';
// ponytail: grants live 24 h unless revoked; phase 5 expires them when the ticket closes.
const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ArgvIn {
  cli: Cli;
  model: string;
  effort: Effort;
  promptPath: string;
  /** Claude Code: the session's mcp.json (URL + bearer header). */
  mcpConfigPath: string;
  /** Codex: the daemon's /mcp URL, passed as a per-process config override. */
  mcpUrl: string;
  cwd: string;
}

/**
 * The exact command line per CLI, flags verified against the installed `--help` (docs/CLIS.md).
 * The initial message points at prompt.md instead of carrying it: Windows caps a command line at 32 767 characters
 * (a test prompt holds the whole diff) and cmd.exe cannot pass a newline inside an argument.
 */
export function buildArgv(a: ArgvIn): string[] {
  const message = `Read ${relative(a.cwd, a.promptPath).replaceAll('\\', '/')} in full and follow it. It is your brief for this session.`;
  switch (a.cli) {
    case 'claude':
      // --mcp-config is variadic, so it goes first and a boolean flag sits between it and the message.
      return ['claude', '--mcp-config', a.mcpConfigPath, '--strict-mcp-config', '--model', a.model, '--effort', a.effort,
        '--dangerously-skip-permissions', message];
    case 'codex':
      // Unquoted -c values fail TOML parsing and are taken as literal strings, which keeps `"` out of the cmd.exe line.
      return ['codex', '--model', a.model, '-c', `model_reasoning_effort=${a.effort}`,
        '-c', `mcp_servers.kanban95.url=${a.mcpUrl}`, '-c', `mcp_servers.kanban95.bearer_token_env_var=${TOKEN_ENV}`,
        '--dangerously-bypass-approvals-and-sandbox', message];
  }
}

export interface Session {
  runId: number;
  grantId: number;
  ticketId: number;
  dir: string;
  pty: IPty;
  scrollback: () => string;
  /** Resolves once the run row is written, the grant revoked and the session dir gone. */
  done: Promise<void>;
}

/** Live sessions by run id. */
export const sessions = new Map<number, Session>();

export const sessionDir = (repo: string, runId: number) => join(repo, '.kanban95', 'sessions', String(runId));

/** Owner-only: mode 0700 on POSIX; on Windows inheritance is cut and only the current user is granted access. */
function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${userInfo().username}:(OI)(CI)F`], { stdio: 'ignore' });
  }
}

export function launch(
  d: { db: DatabaseSync; repo: string; port: number },
  o: { ticketId: number; template: Exclude<TemplateName, 'brainstorm'>; cli: Cli; model: string; effort: Effort },
): Session {
  const { db, repo } = d;
  const wt = createWorktree(repo, o.ticketId);
  const run = startRun(db, repo, { ...o, worktree: wt.path, base: wt.base });
  const grant = mint(db, { ticket: o.ticketId, role: TEMPLATES[o.template].role, ttlMs: GRANT_TTL_MS });
  const dir = sessionDir(repo, run.id);
  const teardown = (scrollback: string | null) => {
    try {
      db.prepare("UPDATE runs SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), scrollback = ? WHERE id = ?").run(scrollback, run.id);
      revoke(db, grant.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  try {
    const mcpUrl = `http://127.0.0.1:${d.port}/mcp`;
    privateDir(dir);
    const promptPath = join(dir, 'prompt.md');
    const mcpConfigPath = join(dir, 'mcp.json');
    writeFileSync(promptPath, run.prompt, { mode: 0o600 });
    if (o.cli === 'claude') {
      const cfg = { mcpServers: { kanban95: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${grant.token}` } } } };
      writeFileSync(mcpConfigPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    }
    const [cmd, ...args] = buildArgv({ ...o, promptPath, mcpConfigPath, mcpUrl, cwd: wt.path });
    const env = childEnv(o.cli === 'codex' ? { [TOKEN_ENV]: grant.token } : {});
    const { pty, scrollback } = spawnPty(cmd, args, { cwd: wt.path, env });

    let finished!: () => void;
    const s: Session = {
      runId: run.id, grantId: grant.id, ticketId: o.ticketId, dir, pty, scrollback,
      done: new Promise((r) => (finished = r)),
    };
    sessions.set(run.id, s);
    pty.onExit(() => {
      sessions.delete(run.id);
      try {
        teardown(scrollback());
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
