import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BRAIN_BODY_MAX, openDb } from './db.js';

type Row = Record<string, string | number | null>;

const TAG = /^[a-z0-9-]+$/;
const DEPENDS = /^depends:P(\d+)-T(\d+)$/i;

function isoTime(t: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? `${t.replace(' ', 'T')}.000Z` : t;
}

function unquote(v: string): string {
  const s = v.trim();
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

function frontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string | string[]> = {};
  let list: string[] | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) { list.push(unquote(item[1])); continue; }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    list = null;
    if (value === '') meta[key] = list = [];
    else if (/^\[.*\]$/.test(value.trim())) meta[key] = value.trim().slice(1, -1).split(',').map(unquote).filter(Boolean);
    else meta[key] = unquote(value);
  }
  return { meta, body: text.slice(m[0].length) };
}

export function importBoard(oldPath: string, boardName: string, target: string): { code: number; lines: string[] } {
  const lines: string[] = [];
  const old = new DatabaseSync(oldPath, { readOnly: true });
  try {
    const board = old.prepare('SELECT id, project_number, repo_paths FROM boards WHERE name = ?').get(boardName) as Row | undefined;
    if (!board) {
      lines.push(`No board named "${boardName}". Boards in ${oldPath}:`);
      for (const r of old.prepare('SELECT name FROM boards ORDER BY name').all() as Row[]) lines.push(`  ${r.name}`);
      return { code: 1, lines };
    }
    const project = Number(board.project_number);
    const tasks = old.prepare('SELECT * FROM tasks WHERE board_id = ? ORDER BY task_number').all(board.id) as Row[];
    const comments = old.prepare(
      'SELECT c.author, c.content, c.created_at, t.task_number FROM comments c JOIN tasks t ON t.id = c.task_id WHERE t.board_id = ? ORDER BY c.id',
    ).all(board.id) as Row[];
    const traps = old.prepare('SELECT * FROM traps WHERE board_id = ? ORDER BY id').all(board.id) as Row[];

    const db = openDb(target);
    try {
      const has = db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number };
      if (has.n > 0) {
        lines.push(`${target} already has ${has.n} ticket(s). The importer never merges; use an empty target.`);
        return { code: 1, lines };
      }

      const numbers = new Set(tasks.map((t) => Number(t.task_number)));
      const deps: [number, number][] = [];
      const tickets = tasks.map((t) => {
        const id = Number(t.task_number);
        const ref = `P${project}-T${id}`;
        const body = [`Imported from AI Task Board ${ref}`];
        if (String(t.description ?? '').trim()) body.push('', String(t.description).trim());
        for (const [label, col] of [['Deliverable', 'deliverable'], ['Relevant files', 'relevant_files'], ['Task context', 'agent_context'], ['Session handoff', 'session_handoff']]) {
          const v = String(t[col] ?? '').trim();
          if (v) body.push('', `## ${label}`, '', v);
        }
        const tags = new Set<string>();
        const depLines: string[] = [];
        for (const raw of JSON.parse(String(t.tags || '[]')) as string[]) {
          const dep = DEPENDS.exec(raw);
          if (dep) {
            const depRef = `P${dep[1]}-T${dep[2]}`;
            const on = Number(dep[2]);
            if (Number(dep[1]) !== project) {
              depLines.push(`Depended on ${depRef} on another board`);
              lines.push(`dropped: ${ref} tag ${raw} (points at another board)`);
            } else if (!numbers.has(on) || on === id) {
              depLines.push(`Depended on ${depRef}, which is not on this board`);
              lines.push(`dropped: ${ref} tag ${raw} (no such task on this board)`);
            } else deps.push([id, on]);
            continue;
          }
          const tag = raw.trim().toLowerCase();
          if (/^depends:/.test(tag)) lines.push(`dropped: ${ref} tag ${raw} (unreadable depends tag)`);
          else if (TAG.test(tag)) tags.add(tag);
          else lines.push(`dropped: ${ref} tag ${raw} (not a-z, 0-9 and -)`);
        }
        if (depLines.length) body.push('', ...depLines);
        const checks = JSON.parse(String(t.acceptance_checks || '[]')) as { cmd: string; note?: string }[];
        return {
          id,
          title: String(t.title),
          body: body.join('\n'),
          criteria: checks.map((c) => (c.note ? `${c.cmd} -- ${c.note}` : c.cmd)).join('\n'),
          status: t.status === 'completed' || t.status === 'closed' ? 'done' : 'backlog',
          tags: [...tags].join(' '),
          created_at: isoTime(String(t.created_at)),
          updated_at: isoTime(String(t.updated_at)),
        };
      });

      const brain: { title: string; body: string; tags: string }[] = [];
      let vaultNotes = 0;
      const repo = String(board.repo_paths ?? '').split(/\r?\n/)[0].trim();
      const vault = repo ? join(repo, 'brain') : '';
      if (!vault || !existsSync(vault)) lines.push(`no vault: ${vault || '(board has no repo path)'} does not exist, brain notes skipped`);
      else {
        for (const sub of ['knowledge', 'playbooks']) {
          const dir = join(vault, sub);
          if (!existsSync(dir)) continue;
          for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
            vaultNotes++;
            const { meta, body } = frontmatter(readFileSync(join(dir, file), 'utf8'));
            if (meta.status === 'superseded') { lines.push(`dropped: ${sub}/${file} (status: superseded)`); continue; }
            let text = body.trim();
            if (text.length > BRAIN_BODY_MAX) { text = text.slice(0, BRAIN_BODY_MAX); lines.push(`cut: ${sub}/${file} body to ${BRAIN_BODY_MAX} characters`); }
            const tags = [...(Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : []), ...(typeof meta.channel === 'string' ? [meta.channel] : [])];
            brain.push({ title: typeof meta.title === 'string' && meta.title ? meta.title : file.slice(0, -3), body: text, tags: tags.join(' ') });
          }
        }
      }
      for (const trap of traps) {
        if (trap.superseded_by !== null) { lines.push(`dropped: trap ${trap.id} on ${trap.file_key} (superseded by trap ${trap.superseded_by})`); continue; }
        let text = String(trap.content).trim();
        if (String(trap.source_ref ?? '').trim()) text += `\nSource: ${String(trap.source_ref).trim()}`;
        if (text.length > BRAIN_BODY_MAX) { text = text.slice(0, BRAIN_BODY_MAX); lines.push(`cut: trap ${trap.id} body to ${BRAIN_BODY_MAX} characters`); }
        brain.push({ title: `Trap: ${trap.file_key}`, body: text, tags: `trap ${trap.file_key}` });
      }

      db.exec('BEGIN');
      try {
        const insTicket = db.prepare('INSERT INTO tickets (id, title, body, criteria, status, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const t of tickets) insTicket.run(t.id, t.title, t.body, t.criteria, t.status, t.tags, t.created_at, t.updated_at);
        const insDep = db.prepare('INSERT OR IGNORE INTO ticket_deps (ticket_id, depends_on_id) VALUES (?, ?)');
        for (const [a, b] of deps) insDep.run(a, b);
        const insNote = db.prepare("INSERT INTO notes (ticket_id, role, kind, body, created_at) VALUES (?, ?, 'decision', ?, ?)");
        for (const c of comments) insNote.run(Number(c.task_number), c.author === 'human' ? 'operator' : 'worker', String(c.content), isoTime(String(c.created_at)));
        const insBrain = db.prepare('INSERT INTO brain (title, body, tags) VALUES (?, ?, ?)');
        for (const b of brain) insBrain.run(b.title, b.body, b.tags);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      lines.unshift(
        `${tasks.length} tasks -> ${tickets.length} tickets`,
        `${comments.length} comments -> ${comments.length} notes`,
        `${vaultNotes} vault notes + ${traps.length} traps -> ${brain.length} brain rows`,
      );
      return { code: 0, lines };
    } finally {
      db.close();
    }
  } finally {
    old.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [oldPath, name, target] = process.argv.slice(2);
  if (!oldPath || !name || !target) {
    console.error('usage: node daemon/dist/import-ai-task-board.js <old tasks.db> "<board name>" <target folder>');
    process.exit(1);
  }
  const { code, lines } = importBoard(oldPath, name, target);
  for (const l of lines) (code ? console.error : console.log)(l);
  process.exit(code);
}
