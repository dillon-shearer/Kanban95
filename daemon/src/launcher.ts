// Launches an agent CLI on a ticket: worktree, run row, grant, session dir, argv, pty. Tears it all down on exit or revoke.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { IPty } from 'node-pty';
import { buildContext, startRun } from './context.js';
import { createWorktree, git, worktreesRoot } from './git.js';
import { mint, revoke, type Role } from './grants.js';
import { childEnv, cmdSafe, spawnPty } from './pty.js';
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
/** The initial message of a resumed Claude Code session, in place of the brief: the conversation already holds it. */
export const RESUME_MESSAGE = 'The board restarted this session after it ended without reporting. Your board tools work again under a new grant; carry on where you left off.';

export interface ArgvIn {
  cli: Cli;
  role: Role;
  /** The main repo root and its worktrees root (`worktreesRoot`): Codex is told per process that both are trusted (docs/CLIS.md). */
  repo: string;
  wtRoot: string;
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
  /** Claude Code: the conversation's id, chosen at launch (`--session-id`), or the killed one to continue when `resume` is set. */
  sessionId?: string;
  resume?: boolean;
}

/**
 * The exact command line per CLI, flags verified against the installed `--help` (docs/CLIS.md).
 * The initial message points at prompt.md instead of carrying it: Windows caps a command line at 32 767 characters
 * (a test prompt holds the whole diff) and cmd.exe cannot pass a newline inside an argument.
 * Reach is limited by role, not by approvals: a planner cannot write files; workers, testers and the operator run with permissions off.
 */
export function buildArgv(a: ArgvIn): string[] {
  // Absolute: given the relative form, agents resolved it against the home directory and had to retry (12 sessions, ticket #81).
  // A path cmd.exe cannot carry (docs/CLIS.md) keeps the relative form, which drops the folders the worktree and the repo share,
  // where such a character may sit.
  const abs = resolve(a.promptPath);
  const brief = `Read ${(cmdSafe(abs) ? abs : relative(a.cwd, abs)).replaceAll('\\', '/')} in full and follow it. It is your brief for this session.`;
  const planner = a.role === 'planner';
  switch (a.cli) {
    case 'claude':
      // --mcp-config and --disallowedTools are variadic, so each is followed by another flag, never by the message.
      // An empty model (an operator terminal with no operator row in models.json) runs the CLI's own default model.
      // Workers and testers load no user settings, so none of the operator's plugin hooks, and no skills: none was invoked in
      // 113 measured runs, while the hooks and skill listing cost ~15k tokens on every call (ticket #43, operator approved).
      return ['claude', '--mcp-config', a.mcpConfigPath, '--strict-mcp-config',
        ...(a.sessionId ? [a.resume ? '--resume' : '--session-id', a.sessionId] : []), ...(a.model ? ['--model', a.model] : []), '--effort', a.effort,
        ...(planner ? ['--disallowedTools', ...PLANNER_DENY] : []),
        ...(unattended(a.role) ? ['--setting-sources', 'project,local', '--settings', a.settingsPath, '--disable-slash-commands'] : []),
        '--dangerously-skip-permissions', a.resume ? RESUME_MESSAGE : brief];
    case 'codex': {
      // Unquoted -c values fail TOML parsing and are taken as literal strings, which keeps `"` out of the cmd.exe line.
      // The trust table's keys are TOML literal strings, which cannot hold a single quote.
      const quote = [a.wtRoot, a.repo].find((p) => p.includes("'"));
      if (quote) throw new Error(`cannot pre-trust a path containing ' for Codex: ${quote}`);
      // Workers and testers keep the bypass: under -s workspace-write Codex on Windows runs commands as a sandbox account
      // and git refuses the worktree ("dubious ownership"), so an agent could not commit (docs/CLIS.md).
      return ['codex', ...(a.model ? ['--model', a.model] : []), '-c', `model_reasoning_effort=${a.effort}`,
        '-c', `mcp_servers.kanban95.url=${a.mcpUrl}`, '-c', `mcp_servers.kanban95.bearer_token_env_var=${TOKEN_ENV}`,
        // The board's own tools are pre-approved (`approve`; `auto` still asks); the grant already scopes them. Without this a
        // planner under -a never is refused every MCP call ("requires approval, but approval policy is never"; checked live).
        '-c', 'mcp_servers.kanban95.default_tools_approval_mode=approve',
        '-c', `projects={'${a.wtRoot}'={trust_level='trusted'},'${a.repo}'={trust_level='trusted'}}`,
        ...(planner ? ['-s', 'read-only', '-a', 'never'] : ['--dangerously-bypass-approvals-and-sandbox']), brief];
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
  cli: Cli;
  cwd: string;
  /** Claude Code's conversation id; Codex has none the board knows (`transcriptSize`). */
  sessionId?: string;
  /** Date.now() at spawn. */
  started: number;
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

type Daemon = { db: DatabaseSync; brain: DatabaseSync; repo: string; port: number; onExit?: (s: Session) => void };
/** `path`: the operator's configured executable for the CLI (Settings); the bare name, resolved through PATH, when unset. */
type RunSettings = { cli: Cli; model: string; effort: Effort; path?: string };

/** How many of the setup command's last output lines a failure note quotes. */
const SETUP_TAIL = 20;
// ponytail: on Windows the timeout kills cmd.exe, not what it started (npm keeps running); upgrade is `taskkill /T`.
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Creates the ticket's worktree and runs the repo's `worktree_setup` command in it once (`npm ci` for this repo), in the same
 * environment an agent gets. Null when there is nothing to run: no command, or it already succeeded in this worktree (a
 * marker in the worktree's git dir, gone with the worktree). Asynchronous so a minute of `npm ci` does not stall the daemon.
 * Rejects with the command and its last output lines.
 */
export function prepareWorktree(repo: string, ticketId: number, command?: string): Promise<void> | null {
  const wt = createWorktree(repo, ticketId);
  if (!command) return null;
  const marker = resolve(wt.path, git(wt.path, 'rev-parse', '--git-path', 'kanban95-setup-done'));
  if (existsSync(marker)) return null;
  return new Promise((ok, fail) => {
    const child = spawn(command, { cwd: wt.path, env: childEnv({ KANBAN95_AGENT: '1' }), shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: SETUP_TIMEOUT_MS });
    let out = '';
    const take = (d: Buffer) => (out = (out + d).slice(-65536));
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => fail(new Error(`worktree_setup "${command}" did not start: ${e.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) {
        writeFileSync(marker, command);
        return ok();
      }
      const tail = out.split(/\r?\n/).filter((l) => l.trim()).slice(-SETUP_TAIL).join('\n');
      fail(new Error(`worktree_setup "${command}" failed (${code ?? signal}) in ${wt.path}; last output:\n${tail || '(none)'}`));
    });
  });
}

/**
 * Claude Code keeps each conversation in `<config>/projects/<cwd, mangled>/<id>.jsonl`. Every project dir is searched rather than
 * the mangling copied: the id is a UUID, so a match anywhere is this session's.
 */
function claudeTranscript(id: string): string | undefined {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  try {
    return readdirSync(projects).map((p) => join(projects, p, `${id}.jsonl`)).find((f) => existsSync(f));
  } catch {
    return undefined;
  }
}
const hasTranscript = (id: string) => claudeTranscript(id) !== undefined;

const samePath = (a: string, b: string) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
/** Codex's `session_meta` line names the cwd near its start, before the long instructions. */
const ROLLOUT_HEAD = 4096;

/**
 * Codex keeps each conversation in `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl` (local date) and the board
 * does not learn the id. The session's file is the newest one written since it started whose `session_meta` cwd is its worktree;
 * a retry in the same worktree starts after the previous file's last write.
 * ponytail: scans the start's and today's date dirs; upgrade is to record the id Codex prints (launch's resume ponytail).
 */
function codexRollout(cwd: string, started: number): string | undefined {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  const day = (t: number) => { const d = new Date(t); return join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')); };
  const files = [...new Set([day(started), day(Date.now())])].flatMap((d) => {
    try {
      return readdirSync(join(root, d)).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl')).map((f) => join(root, d, f));
    } catch {
      return [];
    }
  }).sort().reverse(); // the name starts with the time it was created: newest first
  for (const f of files) {
    try {
      if (statSync(f).mtimeMs < started - 1000) continue;
      const fd = openSync(f, 'r');
      const buf = Buffer.alloc(ROLLOUT_HEAD);
      const n = readSync(fd, buf, 0, ROLLOUT_HEAD, 0);
      closeSync(fd);
      const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, n));
      if (m && samePath(JSON.parse(m[1]), cwd)) return f;
    } catch { /* gone or unreadable: not this session's */ }
  }
  return undefined;
}

/** The size in bytes of the session's transcript (Claude Code) or rollout (Codex), or -1 while there is none. Silence watch (lifecycle). */
export function transcriptSize(s: Pick<Session, 'cli' | 'cwd' | 'sessionId' | 'started'>): number {
  const f = s.cli === 'claude' ? s.sessionId && claudeTranscript(s.sessionId) : codexRollout(s.cwd, s.started);
  try {
    return f ? statSync(f).size : -1;
  } catch {
    return -1;
  }
}

/**
 * The Claude Code session to continue for `ticketId` in `phase`: the latest run's, when that run was Claude in the same phase,
 * ended without reporting (killed by a restart, a crash or the operator's X) and its transcript is still on disk.
 */
function resumable(db: DatabaseSync, ticketId: number, phase: string): string | undefined {
  const r = db.prepare('SELECT phase, cli, outcome, session_id FROM runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(ticketId) as
    { phase: string; cli: string; outcome: string | null; session_id: string | null } | undefined;
  if (r?.phase !== phase || r.cli !== 'claude' || !r.session_id || !['exit', 'lost', 'closed'].includes(r.outcome ?? '')) return undefined;
  return hasTranscript(r.session_id) ? r.session_id : undefined;
}

/** `resume`: continue the phase's killed Claude Code conversation when there is one (`resumable`); otherwise a fresh session. */
export function launch(d: Daemon, o: { ticketId: number; template: TicketTemplate; resume?: boolean } & RunSettings): Session {
  const { role, phase } = TEMPLATES[o.template];
  const wt = createWorktree(d.repo, o.ticketId);
  // ponytail: Codex always starts fresh with the failure notes in its brief; upgrade is to record the session id Codex prints
  // and launch `codex resume <id>` (docs/CLIS.md → Resuming a killed session).
  const prior = o.resume && o.cli === 'claude' ? resumable(d.db, o.ticketId, phase) : undefined;
  const sessionId = o.cli === 'claude' ? prior ?? randomUUID() : undefined;
  const run = startRun(d.db, d.repo, { ...o, worktree: wt.path, base: wt.base, sessionId, global: d.brain });
  return spawnSession(d, { ...o, sessionId, resume: prior !== undefined }, { runId: run.id, ticketId: o.ticketId, role, phase, cwd: wt.path, prompt: run.prompt });
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
  if (o.mission && !/\{\{\s*mission\s*\}\}/.test(text)) throw new BadConfig(`${o.template}.md has no {{mission}}: reset it in Settings → Prompts`);
  if (o.mission) ctx.mission = o.mission;
  const prompt = fill(text, ctx);
  return spawnSession(d, o, { runId: null, ticketId: null, role, phase: o.template, cwd: d.repo, prompt });
}

function spawnSession(d: Daemon, o: RunSettings & { sessionId?: string; resume?: boolean }, r: { runId: number | null; ticketId: number | null; role: Role; phase: string; cwd: string; prompt: string }): Session {
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
    const wtRoot = worktreesRoot(repo);
    const [cmd, ...args] = buildArgv({ ...o, role: r.role, repo: resolve(repo), wtRoot, promptPath, mcpConfigPath, settingsPath, mcpUrl, cwd: r.cwd });
    if (o.cli === 'claude') preTrustClaude(db, r.ticketId, r.ticketId === null ? repo : wtRoot);
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
      cli: o.cli, cwd: r.cwd, sessionId: o.sessionId, started: Date.now(),
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
