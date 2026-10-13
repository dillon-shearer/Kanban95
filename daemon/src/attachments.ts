// Ticket attachments: files the operator hands the agents, under <repo>/.kanban95/attachments/<ticket id>/ (docs/DATA.md).
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

export const MAX_ATTACHMENT = 10 << 20;

export const attachmentDir = (repo: string, ticketId: number) => join(repo, '.kanban95', 'attachments', String(ticketId));

/** A ticket's attachments by name, with the absolute path an agent opens. */
export function attachments(repo: string, ticketId: number): { name: string; path: string; size: number }[] {
  const dir = attachmentDir(repo, ticketId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((name) => ({ name, path: join(dir, name), size: statSync(join(dir, name)).size }));
}

/**
 * The basename a file is stored under, or null when the name is refused: a path separator or `..` is never cleaned up
 * into something else. Anything outside letters, digits and ` ._()+-` becomes `_`; Windows' trailing dots and spaces
 * and its device names (CON, NUL, COM1...) are made harmless.
 */
export function safeName(name: string): string | null {
  if (/[\\/]/.test(name) || name.includes('..')) return null;
  let s = name.replace(/[^\p{L}\p{N} ._()+-]/gu, '_').replace(/[. ]+$/, '');
  const ext = extname(s);
  if (s.length > 120) s = s.slice(0, 120 - ext.length) + ext;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = `_${s}`;
  return s || null;
}

/** Stores `data` as `name` (already safe), never over an existing file: a clash becomes `<stem>-1<ext>`, `-2`... Returns the name used. */
export function saveAttachment(repo: string, ticketId: number, name: string, data: Buffer): string {
  const dir = attachmentDir(repo, ticketId);
  mkdirSync(dir, { recursive: true });
  const ext = extname(name);
  let used = name;
  for (let i = 1; existsSync(join(dir, used)); i++) used = `${name.slice(0, name.length - ext.length)}-${i}${ext}`;
  writeFileSync(join(dir, used), data, { flag: 'wx' });
  return used;
}
