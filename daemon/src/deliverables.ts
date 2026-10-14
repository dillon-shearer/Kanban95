import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { git } from './git.js';

export type Deliverable = { folder: string; ticket_id: number; title: string; merged_at: string };

const PUT = `INSERT INTO deliverables (folder, ticket_id, title, merged_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (folder) DO UPDATE SET ticket_id = excluded.ticket_id, title = excluded.title, merged_at = excluded.merged_at`;
const firstLine = (title: string) => title.split(/\r?\n/)[0].trim();

export function deliverableFolders(files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const dirs = f.split('/').slice(0, -1).slice(0, 2);
    if (!dirs.length || dirs.some((d) => d.startsWith('.'))) continue;
    out.add(dirs.join('/'));
  }
  return [...out].sort();
}

export function recordDeliverables(db: DatabaseSync, repo: string, from: string, to: string, ticketId: number, title: string): string[] {
  const files = git(repo, '-c', 'core.quotepath=off', 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', from, to).split('\0').filter(Boolean);
  const folders = deliverableFolders(files);
  const put = db.prepare(PUT);
  for (const f of folders) put.run(f, ticketId, firstLine(title));
  return folders;
}

export function postDeliverable(db: DatabaseSync, folder: string, ticketId: number, title: string): Deliverable {
  if (!isAbsolute(folder)) throw new Error(`${folder} is not an absolute path`);
  const path = resolve(folder);
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  if (!statSync(path).isDirectory()) throw new Error(`${path} is not a folder`);
  db.prepare(PUT).run(path, ticketId, firstLine(title));
  return db.prepare('SELECT folder, ticket_id, title, merged_at FROM deliverables WHERE folder = ?').get(path) as Deliverable;
}

export const listDeliverables = (db: DatabaseSync) =>
  db.prepare('SELECT folder, ticket_id, title, merged_at FROM deliverables ORDER BY merged_at DESC, folder').all() as Deliverable[];

export const dismissDeliverable = (db: DatabaseSync, folder: string) => Number(db.prepare('DELETE FROM deliverables WHERE folder = ?').run(folder).changes) > 0;

export function openDeliverable(db: DatabaseSync, repo: string, folder: string): void {
  if (!db.prepare('SELECT 1 FROM deliverables WHERE folder = ?').get(folder)) throw new Error(`no Inbox entry for ${folder}`);
  const path = resolve(repo, folder);
  if (!existsSync(path)) throw new Error(isAbsolute(folder) ? `${folder} no longer exists` : `${folder} no longer exists in the main checkout`);
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [path], { detached: true, stdio: 'ignore' });
  child.once('error', (e) => console.error('[deliverables]', e.message));
  child.unref();
}
