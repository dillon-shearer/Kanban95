// Answers Claude Code's workspace-trust prompt for the board's worktrees by writing the key Claude writes itself when a person
// accepts it. Codex needs no file: it takes its trust per process (buildArgv). Keys and evidence in docs/CLIS.md.
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { audit } from './grants.js';

/** Claude Code's state file; it lives under CLAUDE_CONFIG_DIR when that is set. */
export const claudeState = () => join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');

/** Claude Code's key for a folder: the absolute path with forward slashes. */
export const claudeKey = (path: string) => resolve(path).replaceAll('\\', '/');

/**
 * Before a Claude Code launch in `<repo>/.worktrees/t-<id>`. Claude walks up from the working directory looking for a trusted
 * folder, so trusting the repo root once covers every worktree; nothing is written when the root or an ancestor is trusted.
 * The first write backs the file up to `<file>.kanban95.bak` (copied with its mode); the write is an owner-only (0600) temp file
 * renamed over the original, so the file is never half written or left readable by others.
 */
export function preTrustClaude(db: DatabaseSync, ticketId: number | null, repo: string) {
  const file = claudeState();
  const j = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const root = claudeKey(repo);
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

/** For Settings: the repo root's trust entry in Claude Code's state file, and whether the board ever wrote it. */
export function trustStatus(db: DatabaseSync, repo: string) {
  const file = claudeState();
  const key = claudeKey(repo);
  const j = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const byBoard = db.prepare("SELECT 1 FROM audit WHERE tool = 'trust.write' AND outcome = 'ok' LIMIT 1").get() !== undefined;
  return { file, key, trusted: j.projects?.[key]?.hasTrustDialogAccepted === true, byBoard };
}

/**
 * Settings → Clear: removes `hasTrustDialogAccepted` from the repo root's entry and nothing else (Claude Code keeps other
 * per-folder state there). The next Claude launch writes it again; clearing is for when the board is no longer used here.
 */
export function untrustClaude(db: DatabaseSync, repo: string) {
  const file = claudeState();
  const key = claudeKey(repo);
  if (!existsSync(file)) return;
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (j.projects?.[key]?.hasTrustDialogAccepted === undefined) return;
  delete j.projects[key].hasTrustDialogAccepted;
  save(file, j);
  audit(db, { grant_id: null, ticket_id: null, tool: 'trust.clear', args: { file, key: `projects["${key}"].hasTrustDialogAccepted` }, outcome: 'ok' });
}
