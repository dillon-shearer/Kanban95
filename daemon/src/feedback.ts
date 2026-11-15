import type { DatabaseSync } from 'node:sqlite';

export const FEEDBACK_TYPES = ['bug', 'idea', 'missing_capability'] as const;
export const FAILURE_MODES = [
  'instruction_following',
  'destructive_actions',
  'code_quality',
  'repetition_and_looping',
  'model_regression',
  'overconfidence_and_hallucination',
  'context_and_memory',
  'overeager',
  'over_correction',
  'stopping_short',
  'dispute_or_decline',
  'subagent_overspawn',
  'tone_or_preachiness',
  'excessive_questions',
  'unwanted_scope',
  'other',
] as const;
export const TASK_CATEGORIES = ['code_edit', 'debug', 'explain', 'plan', 'shell', 'search', 'review', 'other'] as const;
export const FEEDBACK_DETAILS_MAX = 8000;

export type Report = {
  from: string;
  type: (typeof FEEDBACK_TYPES)[number];
  title: string;
  area: string;
  failure_mode: string;
  task_category: string;
  details: string;
};
export type Feedback = Omit<Report, 'from'> & {
  id: number; sources: string; count: number; status: string; reason: string | null; ticket_id: number | null; created_at: string; updated_at: string;
};

const COLS = 'id, type, title, area, failure_mode, task_category, details, sources, count, status, reason, ticket_id, created_at, updated_at';
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const key = (title: string) => title.toLowerCase().replace(/[\s.]+$/, '').replace(/\s+/g, ' ').trim();

export function parseReport(o: Record<string, unknown>): Report {
  const text = (k: string): string => {
    const v = o[k];
    if (v !== undefined && typeof v !== 'string') throw new Error(`${k} must be a string`);
    return (v ?? '').trim();
  };
  const r = { from: text('from'), type: text('type'), title: text('title'), area: text('area'), failure_mode: text('failure_mode'), task_category: text('task_category'), details: text('details') };
  if (!r.from || !r.title || !r.details) throw new Error('from, title and details are required');
  if (!(FEEDBACK_TYPES as readonly string[]).includes(r.type)) throw new Error(`type must be one of ${FEEDBACK_TYPES.join(', ')}`);
  if (r.failure_mode && !(FAILURE_MODES as readonly string[]).includes(r.failure_mode)) throw new Error(`failure_mode must be one of ${FAILURE_MODES.join(', ')}`);
  if (r.task_category && !(TASK_CATEGORIES as readonly string[]).includes(r.task_category)) throw new Error(`task_category must be one of ${TASK_CATEGORIES.join(', ')}`);
  if (r.details.length > FEEDBACK_DETAILS_MAX) throw new Error(`details may be at most ${FEEDBACK_DETAILS_MAX} characters`);
  return r as Report;
}

const get = (db: DatabaseSync, id: number) => db.prepare(`SELECT ${COLS} FROM feedback WHERE id = ?`).get(id) as Feedback | undefined;

export function addFeedback(db: DatabaseSync, r: Report): { id: number; count: number; grouped: boolean } {
  const k = key(r.title);
  const open = (db.prepare("SELECT id, title FROM feedback WHERE status = 'open' ORDER BY id").all() as { id: number; title: string }[]).find((f) => key(f.title) === k);
  let id: number;
  if (open) {
    id = open.id;
    db.prepare(`UPDATE feedback SET count = count + 1, sources = sources || char(10) || ?, details = details || ? || ?, updated_at = ${NOW} WHERE id = ?`)
      .run(r.from, `\n\n--- Also reported from ${r.from}\n`, r.details, id);
  } else {
    id = Number(db.prepare('INSERT INTO feedback (type, title, area, failure_mode, task_category, details, sources) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.type, r.title, r.area, r.failure_mode, r.task_category, r.details, r.from).lastInsertRowid);
  }
  return { id, count: get(db, id)!.count, grouped: !!open };
}

export const listFeedback = (db: DatabaseSync) =>
  db.prepare(`SELECT ${COLS} FROM feedback WHERE status = 'open' ORDER BY count DESC, updated_at DESC, id`).all() as Feedback[];

function openItem(db: DatabaseSync, id: number): Feedback {
  const f = get(db, id);
  if (!f) throw new Error(`no feedback #${id}`);
  if (f.status !== 'open') throw new Error(`feedback #${id} is already ${f.status}`);
  return f;
}

export function incorporateFeedback(db: DatabaseSync, id: number): number {
  const f = openItem(db, id);
  const facts = [
    `Type: ${f.type}`,
    f.area && `Area: ${f.area}`,
    f.failure_mode && `Failure mode: ${f.failure_mode}`,
    f.task_category && `Task category: ${f.task_category}`,
    `Reported ${f.count} time${f.count === 1 ? '' : 's'}, from: ${f.sources.split('\n').join(', ')}`,
  ].filter(Boolean).join('\n');
  const body = `From feedback #${f.id}\n\n${facts}\n\n${f.details}`;
  const ticket = Number(db.prepare("INSERT INTO tickets (title, body, criteria, tags) VALUES (?, ?, '', '')").run(f.title, body).lastInsertRowid);
  db.prepare(`UPDATE feedback SET status = 'incorporated', ticket_id = ?, updated_at = ${NOW} WHERE id = ?`).run(ticket, id);
  return ticket;
}

export function dropFeedback(db: DatabaseSync, id: number, reason: string): void {
  openItem(db, id);
  db.prepare(`UPDATE feedback SET status = 'dropped', reason = ?, updated_at = ${NOW} WHERE id = ?`).run(reason, id);
}
