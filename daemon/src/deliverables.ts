import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export type Deliverable = { folder: string; ticket_id: number | null; title: string; merged_at: string };

const PUT = `INSERT INTO deliverables (folder, ticket_id, title, merged_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (folder) DO UPDATE SET ticket_id = excluded.ticket_id, title = excluded.title, merged_at = excluded.merged_at`;
const firstLine = (title: string) => title.split(/\r?\n/)[0].trim();

export function postDeliverable(db: DatabaseSync, folder: string, ticketId: number | null, title: string): Deliverable {
  if (!isAbsolute(folder)) throw new Error(`${folder} is not an absolute path`);
  const path = resolve(folder);
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
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
  const child = spawn(cmd, [statSync(path).isDirectory() ? path : dirname(path)], { detached: true, stdio: 'ignore' });
  child.once('error', (e) => console.error('[deliverables]', e.message));
  child.unref();
}
