// Agent terminals: a pseudo-terminal per run with a minimal environment and a capped scrollback.
import { delimiter, dirname } from 'node:path';
import { spawn, type IPty } from 'node-pty';

const SCROLLBACK_LINES = 2000;

/**
 * The only daemon variables a CLI inherits: what Windows and a shell need to run, where the user's home and temp are
 * (Claude Code and Codex keep their own auth under the home dir), and the CLIs' own config-dir overrides.
 * Nothing else crosses, so a secret in the daemon's environment never reaches an agent.
 */
const ENV_ALLOW = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME',
  'TEMP', 'TMP', 'TMPDIR', 'LANG',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
];

export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  // NoDefaultCurrentDirectoryInExePath: cmd.exe would otherwise run a `claude.cmd` sitting in the worktree before the real one.
  const env: Record<string, string> = { TERM: 'xterm-256color', NoDefaultCurrentDirectoryInExePath: '1' };
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k]; // process.env is case-insensitive on Windows
  // The daemon's own Node (24) first: the operator's PATH `node` may be older, and the tests need 24 (node:sqlite with fts5).
  env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter);
  return { ...env, ...extra };
}

/** Whether an argument can pass through cmd.exe unescaped: `"`, `%` and newlines cannot, and a trailing `\` would escape the closing quote. */
export const cmdSafe = (a: string) => !/["%\r\n]/.test(a) && !a.endsWith('\\');

/**
 * Windows: cmd.exe resolves `claude` (.exe) and `codex` (an npm .cmd shim) through PATHEXT, which conpty alone does not.
 * The command line is built here because node-pty's own quoting is MSVCRT-style, which cmd.exe does not read.
 */
function windowsCommandLine(cmd: string, args: string[]): string {
  const quoted = [cmd, ...args].map((a) => {
    if (!cmdSafe(a)) throw new Error(`argument not safe to pass through cmd.exe: ${a}`);
    return /^[\w\-.:/=\\]+$/.test(a) ? a : `"${a}"`;
  });
  return `/d /s /c "${quoted.join(' ')}"`;
}

export function spawnPty(cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; cols?: number; rows?: number }) {
  const opts = { name: 'xterm-256color', cwd: o.cwd, env: o.env, cols: o.cols ?? 120, rows: o.rows ?? 30 };
  const pty: IPty = process.platform === 'win32'
    ? spawn(o.env.ComSpec ?? 'cmd.exe', windowsCommandLine(cmd, args), opts)
    : spawn(cmd, args, opts);

  // Raw terminal output, trimmed to the last SCROLLBACK_LINES lines whenever it grows to twice that.
  let buf = '';
  let lines = 0;
  const trim = () => {
    const parts = buf.split('\n');
    buf = parts.slice(-SCROLLBACK_LINES).join('\n');
    lines = Math.min(parts.length, SCROLLBACK_LINES) - 1;
  };
  pty.onData((d) => {
    buf += d;
    for (const c of d) if (c === '\n') lines++;
    if (lines >= 2 * SCROLLBACK_LINES) trim();
  });
  return {
    pty,
    scrollback: () => {
      trim();
      return buf;
    },
  };
}

/**
 * The last `n` lines of text in raw terminal output, for a note: escape sequences dropped, a cursor move taken as a line break
 * (a TUI such as Claude Code's positions text rather than printing newlines), blank and repeated lines skipped, each cut at 200 characters.
 */
export function lastLines(raw: string, n: number): string[] {
  const text = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (window title, hyperlinks)
    .replace(/\x1b\[[0-?]*[ -/]*[HfABEFGd]/g, '\n') // CSI cursor moves
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // every other CSI
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => (c === '\r' ? '\n' : ''));
  const out: string[] = [];
  for (const l of text.split('\n').map((x) => x.trim().slice(0, 200)).filter(Boolean)) if (out.at(-1) !== l) out.push(l);
  return out.slice(-n);
}
