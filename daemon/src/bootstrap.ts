import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTicket, setDeps, transaction, type Ticket } from './api.js';
import { changed, Refused, type Board } from './lifecycle.js';
import { BadConfig } from './settings.js';

export const bootstrapPath = (repo: string) => join(repo, '.kanban95', 'templates', 'bootstrap.md');

export interface Starter { title: string; body: string; criteria: string }

export function parseBootstrap(text: string): Starter[] {
  const out: { title: string; inCriteria: boolean; lines: string[]; crit: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const title = /^##\s+(.+?)\s*$/.exec(line);
    if (title) { out.push({ title: title[1], inCriteria: false, lines: [], crit: [] }); continue; }
    const cur = out.at(-1);
    if (!cur) continue;
    if (/^Criteria:\s*$/.test(line)) cur.inCriteria = true;
    else if (cur.inCriteria) { const c = line.replace(/^\s*[-*]\s+/, '').trim(); if (c) cur.crit.push(c); }
    else cur.lines.push(line);
  }
  if (!out.length) throw new BadConfig('bootstrap.md has no "## <title>" sections, so there are no tickets to create');
  return out.map((s) => ({ title: s.title, body: s.lines.join('\n').trim(), criteria: s.crit.join('\n') }));
}

export function bootstrap(b: Board, grantId: number | null): Ticket[] {
  const { db } = b;
  if (db.prepare("SELECT 1 FROM tickets WHERE ' ' || tags || ' ' LIKE '% setup %'").get()) throw new Refused('this board already has setup tickets; bootstrap runs once');
  const file = bootstrapPath(b.repo);
  if (!existsSync(file)) throw new BadConfig(`${file} is missing; restart the board to copy the default`);
  const starters = parseBootstrap(readFileSync(file, 'utf8'));
  const ids = transaction(db, () => {
    const ins = db.prepare("INSERT INTO tickets (title, body, criteria, tags, created_by_grant) VALUES (?, ?, ?, 'setup', ?)");
    const ids: number[] = [];
    for (const s of starters) {
      const id = Number(ins.run(s.title, s.body, s.criteria, grantId).lastInsertRowid);
      if (ids.length) setDeps(db, id, [ids.at(-1)!]);
      ids.push(id);
    }
    return ids;
  });
  for (const id of ids) changed(id);
  return ids.map((id) => readTicket(db, id));
}
