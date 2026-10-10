// Answers Claude Code's workspace-trust prompt for the board's worktrees by writing the key Claude writes itself when a person
// accepts it. Codex needs no file: it takes its trust per process (buildArgv). Keys and evidence in docs/CLIS.md.
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { worktreesRoot } from './git.js';
import { audit } from './grants.js';

/** Claude Code's state file; it lives under CLAUDE_CONFIG_DIR when that is set. */
const claudeState = () => join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');

/** Claude Code's key for a folder: the absolute path with forward slashes. */
const claudeKey = (path: string) => resolve(path).replaceAll('\\', '/');

/**
 * Before a Claude Code launch in `dir`'s tree: the repo's worktrees root (`worktreesRoot`) for a ticket, the repo itself for a
 * brainstorm or operator terminal. Claude walks up from the working directory looking for a trusted folder, so trusting the
 * worktrees root once covers every ticket worktree; nothing is written when `dir` or an ancestor is trusted.
 * The first write backs the file up to `<file>.kanban95.bak` (copied with its mode); the write is an owner-only (0600) temp file
 * renamed over the original, so the file is never half written or left readable by others.
 */
export function preTrustClaude(db: DatabaseSync, ticketId: number | null, dir: string) {
  const file = claudeState();
  const j = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const root = claudeKey(dir);
  for (let p = root; ; p = dirname(p)) {
    if (j.projects?.[p]?.hasTrustDialogAccepted === true) return;
    if (dirname(p) === p) break;
  }
  j.projects ??= {};
  j.projects[root] = { ...j.projects[root], hasTrustDialogAccepted: true };
  save(file, j);
  audit(db, { grant_id: null, ticket_id: ticketId, tool: 'trust.write', args: { file, key: `projects["${root}"].hasTrustDialogAccepted` }, outcome: 'ok' });
}

/** The first write backs the file up; every write is an owner-only temp file renamed over the original. */
function save(file: string, j: unknown) {
  const bak = `${file}.kanban95.bak`;
  if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak);
  // ponytail: no lock shared with Claude Code; a Claude process saving a stale copy in the same instant could drop the key,
  // and that one launch would show the prompt. Take Claude's lock file if it is ever seen.
  // Owner-only, like the file it replaces (it can hold account details); chmod because `mode` is filtered by the umask.
  const tmp = `${file}.kanban95.tmp`;
  writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** For Settings: the trust entry of the repo's worktrees root in Claude Code's state file, and whether the board ever wrote one. */
export function trustStatus(db: DatabaseSync, repo: string) {
  const file = claudeState();
  const key = claudeKey(worktreesRoot(repo));
  const j = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const byBoard = db.prepare("SELECT 1 FROM audit WHERE tool = 'trust.write' AND outcome = 'ok' LIMIT 1").get() !== undefined;
  return { file, key, trusted: j.projects?.[key]?.hasTrustDialogAccepted === true, byBoard };
}

/**
 * Settings → Agents → Clear Claude trust: removes `hasTrustDialogAccepted` from the entries the board writes for this repo (its
 * worktrees root and the repo root) and nothing else (Claude Code keeps other per-folder state there). The next Claude launch
 * writes it again; clearing is for when the board is no longer used here.
 */
export function untrustClaude(db: DatabaseSync, repo: string) {
  const file = claudeState();
  if (!existsSync(file)) return;
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const keys = [claudeKey(worktreesRoot(repo)), claudeKey(repo)].filter((k) => j.projects?.[k]?.hasTrustDialogAccepted !== undefined);
  if (!keys.length) return;
  for (const key of keys) delete j.projects[key].hasTrustDialogAccepted;
  save(file, j);
  for (const key of keys) audit(db, { grant_id: null, ticket_id: null, tool: 'trust.clear', args: { file, key: `projects["${key}"].hasTrustDialogAccepted` }, outcome: 'ok' });
}
