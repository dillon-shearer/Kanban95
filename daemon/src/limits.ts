// The usage limits of the accounts the CLIs are logged into, for Settings → Limits and the tray (docs/OPERATOR.md → Limits).
// Each CLI is asked through its own login; the board never reads a credential file and never holds a token (docs/SECURITY.md).
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { childEnv } from './pty.js';
import { cliPath, CLIS, type Cli } from './settings.js';

export interface Row { cli: Cli; window: string; used: number; limit: number; resets_at: string | null }
export interface Limits { rows: Row[]; errors: Partial<Record<Cli, string>>; fetched_at: string }

export const REFRESH_MS = 5 * 60_000;
const TIMEOUT_MS = 30_000;
const win = process.platform === 'win32';
/** cmd.exe line for a `.cmd` shim (codex); Node refuses to spawn one without a shell. */
const quote = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

/** `Current session: 5% used · resets Oct 8, 7:59pm (America/New_York)`. The breakdown after it is indented, so `^\S` skips it. */
export function parseClaude(text: string): Row[] {
  return [...text.matchAll(/^(\S.*?): (\d+)% used(?:\s*\S\s*resets (.+?))?\s*$/gm)]
    .map((m) => ({ cli: 'claude', window: m[1], used: Number(m[2]), limit: 100, resets_at: m[3] ?? null }));
}

type Window = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
const span = (mins: number | null) => (!mins ? 'window' : mins % 1440 === 0 ? `${mins / 1440} day` : `${mins / 60} hour`);

/** The result of `account/rateLimits/read`: `rateLimits.primary` and `.secondary`. */
export function parseCodex(result: { rateLimits?: { primary?: Window; secondary?: Window } }): Row[] {
  const { primary, secondary } = result.rateLimits ?? {};
  return [primary, secondary].filter((w): w is NonNullable<Window> => !!w).map((w) => ({
    cli: 'codex', window: span(w.windowDurationMins), used: w.usedPercent, limit: 100,
    resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
  }));
}

/** `/usage` is a local slash command: no model call, no quota. Run from a neutral cwd so no repo's settings load. */
const claude = () => new Promise<unknown>((ok, fail) => {
  execFile(cliPath('claude'), ['-p', '--safe-mode', '--no-session-persistence', '/usage'],
    { cwd: tmpdir(), env: childEnv(), timeout: TIMEOUT_MS, windowsHide: true },
    // Never the output in an error: it is the operator's account, and a future CLI could print anything there.
    (err, out) => (err ? fail(new Error(err.killed ? 'claude /usage timed out' : `claude /usage failed (exit ${err.code})`)) : ok(out)));
});

/** `codex app-server` speaks JSON-RPC over stdio, one message per line. */
const codex = () => new Promise<unknown>((ok, fail) => {
  const o = { cwd: tmpdir(), env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] as ['pipe', 'pipe', 'ignore'] };
  const child = win ? spawn(`${quote(cliPath('codex'))} app-server`, { ...o, shell: true }) : spawn(cliPath('codex'), ['app-server'], o);
  const done = (e: Error | null, v?: unknown) => {
    clearTimeout(timer);
    child.stdin.end(); // app-server exits on EOF; kill() would only reach cmd.exe on Windows
    if (e) fail(e); else ok(v);
  };
  const timer = setTimeout(() => done(new Error('codex app-server timed out')), TIMEOUT_MS);
  const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
  child.on('error', (e) => done(new Error(`codex app-server could not start: ${e.message}`)));
  child.on('exit', (code) => done(new Error(`codex app-server exited (${code})`))); // a no-op once settled
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m: { id?: number; result?: unknown; error?: { message?: string } };
    try { m = JSON.parse(line); } catch { return; }
    if (m.id === 1) {
      send({ method: 'initialized' });
      send({ id: 2, method: 'account/rateLimits/read' });
    } else if (m.id === 2) {
      done(m.error ? new Error(`codex: ${m.error.message ?? 'rate limits refused'}`) : null, m.result);
    }
  });
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'kanban95', version: '0' } } });
});

/** What each CLI is asked. Tests swap these for canned output. */
export const sources: Record<Cli, () => Promise<unknown>> = { claude, codex };
const PARSE: Record<Cli, (raw: never) => Row[]> = { claude: parseClaude, codex: parseCodex };

let cached: Limits | null = null;
let running: Promise<Limits> | null = null;

/**
 * The cached result while it is younger than the UI's poll interval, else a fresh one. The CLIs are asked one after the other, and a call
 * while a fetch runs shares it, so there is never more than one CLI start at a time.
 */
export function limits(force = false): Promise<Limits> {
  // fetched_at is stamped when the slowest CLI answers, so the UI's 5 min poll lands up to a fetch's length short of 5 min:
  // count the cache fresh for 5 min less the longest fetch, or every other poll would get the old answer.
  if (!force && cached && Date.now() - Date.parse(cached.fetched_at) < REFRESH_MS - CLIS.length * TIMEOUT_MS) return Promise.resolve(cached);
  running ??= (async () => {
    const out: Limits = { rows: [], errors: {}, fetched_at: '' };
    for (const cli of CLIS) {
      try {
        const rows = PARSE[cli]((await sources[cli]()) as never);
        // ponytail: text and protocol formats, not stable APIs; no rows reads as an error, not as 0%.
        if (!rows.length) throw new Error(`${cli} answered, but no limits could be read from it (format changed?)`);
        out.rows.push(...rows);
      } catch (e) {
        out.errors[cli] = (e as Error).message;
      }
    }
    out.fetched_at = new Date().toISOString();
    return (cached = out);
  })().finally(() => (running = null));
  return running;
}
