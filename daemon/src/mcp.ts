// Agent-facing MCP at /mcp. A bearer grant picks the role; TOOLS below is both the enforcement table and the source of docs/MCP.md.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';
import { brainSearch, readTicket, setDeps, transaction } from './api.js';
import { attachments } from './attachments.js';
import { audit, verify, type Grant, type Role } from './grants.js';
import { apply, changed, Refused, type Board } from './lifecycle.js';
import { EFFORT } from './settings.js';

const STATUS = ['backlog', 'in_progress', 'testing', 'done'] as const;
/** Where each role may move its own ticket. The planner never moves anything. */
const MOVE_TARGETS: Record<Role, readonly (typeof STATUS)[number][]> = {
  planner: [],
  worker: ['testing'],
  tester: ['done', 'in_progress'],
};
/** The only ticket columns a worker may edit on its own ticket. */
const WORKER_FIELDS = ['body', 'criteria'] as const;
const BRAIN_SEARCH_MAX = 20;

/** A refusal. Audited as `denied`; anything else thrown is `error`. */
class Deny extends Error {}

type Call = { board: Board; db: DatabaseSync; grant: Grant; ticket: number | null };
/** A role present in `access` may call the tool; the text is the matrix cell in docs/MCP.md. */
type Access = Partial<Record<Role, string>>;
interface Tool<S extends z.ZodRawShape> {
  description: string;
  access: Access;
  input: S;
  run: (c: Call, args: z.output<z.ZodObject<S>>) => unknown;
}
const tool = <S extends z.ZodRawShape>(t: Tool<S>) => t as unknown as Tool<z.ZodRawShape>;

const ticketId = z.number().int().positive().optional()
  .describe('Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner must give it.');

/** Resolves the ticket a call is about. Worker/tester: their own, a foreign id is a scope denial. Planner: the explicit id. */
function own(c: Call, id: number | undefined): number {
  if (c.grant.role === 'planner') {
    if (id === undefined) throw new Error('ticket_id is required for a planner grant');
    return id;
  }
  if (id !== undefined && id !== c.grant.ticket_id) throw new Deny(`this grant is scoped to ticket ${c.grant.ticket_id}`);
  return c.grant.ticket_id!;
}
const exists = (db: DatabaseSync, id: number) => db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(id) !== undefined;
const depsOf = (db: DatabaseSync, id: number) =>
  (db.prepare('SELECT depends_on_id FROM ticket_deps WHERE ticket_id = ?').all(id) as { depends_on_id: number }[]).map((r) => r.depends_on_id);
function addNote(c: Call, ticket: number, kind: string, body: string): { note_id: number } {
  const r = c.db.prepare('INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, ?, ?, ?)').run(ticket, c.grant.role, kind, body);
  return { note_id: Number(r.lastInsertRowid) };
}
const update = (db: DatabaseSync, id: number, cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(Object.values(cols) as never[]), id);
};

export const TOOLS: Record<string, Tool<z.ZodRawShape>> = {
  create_ticket: tool({
    description:
      'Create a ticket in the backlog. Give it a title, a body that says what to build and why, and acceptance criteria a tester can check one by one. ' +
      'List depends_on ids when this work must wait for other tickets. Set model and effort only when the work clearly warrants it: trivial work gets effort low, hard work gets high. Returns the ticket.',
    access: { planner: 'yes' },
    input: {
      title: z.string().min(1).describe('Short imperative title.'),
      body: z.string().default('').describe('What to build and why, markdown.'),
      criteria: z.string().default('').describe('Acceptance criteria, one checkable statement per line.'),
      depends_on: z.array(z.number().int().positive()).default([]).describe('Ticket ids that must be done before this one starts.'),
      model: z.string().min(1).optional().describe('Model override; omit for the phase default.'),
      effort: z.enum(EFFORT).optional().describe('Effort override; omit for the phase default.'),
    },
    run(c, a) {
      const id = transaction(c.db, () => {
        const r = c.db
          .prepare('INSERT INTO tickets (title, body, criteria, model, effort) VALUES (?, ?, ?, ?, ?)')
          .run(a.title, a.body, a.criteria, a.model ?? null, a.effort ?? null);
        const id = Number(r.lastInsertRowid);
        setDeps(c.db, id, a.depends_on);
        return id;
      });
      c.ticket = id;
      return readTicket(c.db, id);
    },
  }),

  update_ticket: tool({
    description:
      'Edit a ticket\'s title, body, criteria or dependencies. A worker may only refine the body and criteria of its own ticket, for example to record a clarified scope; ' +
      'use add_note for progress and decisions instead. Omitted fields are left unchanged. Returns the ticket.',
    access: { planner: 'any ticket', worker: `own, ${WORKER_FIELDS.join('/')} only` },
    input: {
      ticket_id: ticketId,
      title: z.string().min(1).optional(),
      body: z.string().optional(),
      criteria: z.string().optional(),
      depends_on: z.array(z.number().int().positive()).optional().describe('Replaces the full dependency list.'),
    },
    run(c, { ticket_id, depends_on, ...cols }) {
      const id = (c.ticket = own(c, ticket_id));
      const given = Object.keys(cols).filter((k) => cols[k as keyof typeof cols] !== undefined);
      if (depends_on) given.push('depends_on');
      if (given.length === 0) throw new Error('nothing to update');
      if (c.grant.role === 'worker') {
        const bad = given.filter((k) => !(WORKER_FIELDS as readonly string[]).includes(k));
        if (bad.length) throw new Deny(`a worker may only update ${WORKER_FIELDS.join(', ')}; not ${bad.join(', ')}`);
      }
      readTicket(c.db, id);
      transaction(c.db, () => {
        const set = Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== undefined));
        if (Object.keys(set).length) update(c.db, id, set);
        if (depends_on) setDeps(c.db, id, depends_on);
      });
      return readTicket(c.db, id);
    },
  }),

  set_model: tool({
    description:
      'Change the model and/or effort a ticket runs with; give either or both. Lower effort for trivial work and raise it for hard work, do not only escalate. ' +
      'The ticket\x27s model and effort apply to all its execute runs, retries included. Returns the ticket.',
    access: { planner: 'any' },
    input: {
      ticket_id: ticketId,
      model: z.string().min(1).optional().describe('Model id as listed in the board\'s model catalog.'),
      effort: z.enum(EFFORT).optional(),
    },
    run(c, a) {
      const id = (c.ticket = own(c, a.ticket_id));
      if (a.model === undefined && a.effort === undefined) throw new Error('give model and/or effort');
      readTicket(c.db, id);
      const set: Record<string, unknown> = {};
      if (a.model !== undefined) set.model = a.model;
      if (a.effort !== undefined) set.effort = a.effort;
      update(c.db, id, set);
      return readTicket(c.db, id);
    },
  }),

  move_ticket: tool({
    description:
      'Move a ticket to another column. A worker moves its ticket to testing when the work is committed in the worktree and ready to be checked. ' +
      'A tester moves it to done after report_test with passed true (the board then merges the branch), or back to in_progress after report_test with the failure so the worker retries. ' +
      'Once the move is accepted your session is over: the board ends it and starts the next agent. Returns the ticket.',
    access: { worker: `own → ${MOVE_TARGETS.worker.join(' / ')}`, tester: `own → ${MOVE_TARGETS.tester.join(' / ')}` },
    input: { ticket_id: ticketId, status: z.enum(STATUS) },
    run(c, a) {
      const id = (c.ticket = own(c, a.ticket_id));
      const allowed = MOVE_TARGETS[c.grant.role];
      if (!allowed.includes(a.status)) throw new Deny(`a ${c.grant.role} may only move its ticket to: ${allowed.join(', ')}`);
      return apply(c.board, id, a.status === 'testing' ? 'submit' : a.status === 'done' ? 'pass' : 'fail').ticket;
    },
  }),

  add_note: tool({
    description:
      'Attach a note to a ticket. Kinds: plan (how you intend to do the work, post it before starting), decision (a choice made and why), ' +
      'failure (what went wrong, for the next attempt), summary (what was done, post it when finished). Notes are shown to the operator and injected into later runs of this ticket. Returns the note id.',
    access: { planner: 'any', worker: 'own', tester: 'own' },
    input: {
      ticket_id: ticketId,
      kind: z.enum(['plan', 'decision', 'failure', 'summary']),
      body: z.string().min(1).describe('Markdown.'),
    },
    run(c, a) {
      const id = (c.ticket = own(c, a.ticket_id));
      readTicket(c.db, id);
      return addNote(c, id, a.kind, a.body);
    },
  }),

  get_ticket: tool({
    description:
      'Read one ticket in full: title, body, acceptance criteria, status, flags, dependencies, model settings, the absolute paths of files the operator ' +
      'attached (screenshots and the like: open them with your file reader), and every note on it in order. ' +
      'A worker may also read the tickets its own ticket depends on, to see what they delivered.',
    access: { planner: 'yes', worker: 'own + its deps', tester: 'own' },
    input: { ticket_id: ticketId },
    run(c, a) {
      const { grant } = c;
      const id = grant.role === 'planner' ? own(c, a.ticket_id) : (a.ticket_id ?? grant.ticket_id!);
      c.ticket = id;
      const visible = grant.role === 'planner' || id === grant.ticket_id || (grant.role === 'worker' && depsOf(c.db, grant.ticket_id!).includes(id));
      if (!visible) throw new Deny(`this grant is scoped to ticket ${grant.ticket_id}${grant.role === 'worker' ? ' and its dependencies' : ''}`);
      const ticket = readTicket(c.db, id);
      const notes = c.db.prepare('SELECT id, role, kind, body, created_at FROM notes WHERE ticket_id = ? ORDER BY id').all(id);
      return { ...ticket, attachments: attachments(c.board.repo, id).map((f) => f.path), notes };
    },
  }),

  list_tickets: tool({
    description:
      'List tickets with id, title, status, flags and dependencies, optionally filtered by status. A planner sees the whole board; ' +
      'a worker sees its own ticket and the ones it depends on; a tester sees its own. Use get_ticket for the body and notes.',
    access: { planner: 'yes', worker: 'own + its deps', tester: 'own' },
    input: { status: z.enum(STATUS).optional() },
    run(c, a) {
      const { grant } = c;
      let ids: number[];
      if (grant.role === 'planner') ids = (c.db.prepare('SELECT id FROM tickets ORDER BY id').all() as { id: number }[]).map((r) => r.id);
      else ids = [grant.ticket_id!, ...(grant.role === 'worker' ? depsOf(c.db, grant.ticket_id!) : [])];
      return ids
        .map((id) => readTicket(c.db, id))
        .filter((t) => a.status === undefined || t.status === a.status)
        .map(({ id, title, status, flags, depends_on }) => ({ id, title, status, flags, depends_on }));
    },
  }),

  brain_add: tool({
    description:
      'Save a durable note to the project brain: a decision, a gotcha, a convention, or how a subsystem works. Future tickets that match its title, body or tags get it injected, ' +
      'so write it for a reader with no context. Do not duplicate what the code or docs already say. Returns the brain row id.',
    access: { planner: 'yes', worker: 'yes', tester: 'yes' },
    input: {
      title: z.string().min(1),
      body: z.string().min(1).describe('Markdown.'),
      tags: z.string().default('').describe('Space-separated keywords used for matching.'),
    },
    run(c, a) {
      const r = c.db.prepare('INSERT INTO brain (title, body, tags, ticket_id) VALUES (?, ?, ?, ?)').run(a.title, a.body, a.tags, c.grant.ticket_id);
      return { id: Number(r.lastInsertRowid) };
    },
  }),

  brain_search: tool({
    description:
      'Full-text search the project brain, best match first. Search before making a decision another ticket may already have made, and when you meet an unfamiliar subsystem. ' +
      `Returns up to limit rows (default 5, max ${BRAIN_SEARCH_MAX}) with title, body and tags.`,
    access: { planner: 'yes', worker: 'yes', tester: 'yes' },
    input: {
      query: z.string().min(1).describe('Keywords; each word must match.'),
      limit: z.number().int().min(1).max(BRAIN_SEARCH_MAX).default(5),
    },
    run: (c, a) => brainSearch(c.db, a.query, a.limit),
  }),

  ask_operator: tool({
    description:
      'Ask the human operator a question you cannot resolve from the ticket, the brain or the code. The ticket is flagged needs_human and the operator is alerted; ' +
      'the answer is typed into your session as one line and kept as a note on the ticket. Ask once with full context and the options you see, rather than many small questions. Returns the question id.',
    access: { planner: 'yes', worker: 'own', tester: 'own' },
    input: { ticket_id: ticketId, question: z.string().min(1) },
    run(c, a) {
      const id = (c.ticket = own(c, a.ticket_id));
      const { noteId } = apply(c.board, id, 'ask', { note: { role: c.grant.role, kind: 'question', body: a.question } });
      return { question_id: noteId };
    },
  }),

  report_test: tool({
    description:
      'Record the structured result of testing a ticket against its acceptance criteria. passed is the overall verdict; summary says which criteria passed or failed and why; ' +
      'evidence lists what proves it (test output, screenshot paths kept as run evidence, commands run). Call this before move_ticket. A failed report becomes the failure note the worker sees on retry.',
    access: { tester: 'own' },
    input: {
      ticket_id: ticketId,
      passed: z.boolean(),
      summary: z.string().min(1),
      evidence: z.array(z.string().min(1)).default([]),
    },
    run(c, a) {
      const id = (c.ticket = own(c, a.ticket_id));
      readTicket(c.db, id);
      const body = [`${a.passed ? 'PASS' : 'FAIL'}: ${a.summary}`, ...a.evidence.map((e) => `- ${e}`)].join('\n');
      return addNote(c, id, a.passed ? 'summary' : 'failure', body);
    },
  }),

  report_cleanup: tool({
    description:
      'Record what a housekeeping ticket removed or updated: one item per file or module with the action and the reason (superseded by X, no importers, references removed code). ' +
      'Used by housekeeping tickets only; the list is shown to the operator and kept with the ticket. Returns the note id.',
    access: { worker: 'own' },
    input: {
      ticket_id: ticketId,
      items: z.array(z.object({
        path: z.string().min(1).describe('Repo-relative path.'),
        action: z.enum(['deleted', 'updated']),
        reason: z.string().min(1),
      })).min(1),
    },
    run(c, a) {
      const id = (c.ticket = own(c, a.ticket_id));
      readTicket(c.db, id);
      return addNote(c, id, 'summary', a.items.map((i) => `- ${i.action} \`${i.path}\`: ${i.reason}`).join('\n'));
    },
  }),
};

function registerTools(server: McpServer, board: Board, grant: Grant) {
  const { db } = board;
  for (const [name, t] of Object.entries(TOOLS)) {
    server.registerTool(name, { description: t.description, inputSchema: t.input }, (args) => {
      const a = args as Record<string, unknown>;
      const c: Call = { board, db, grant, ticket: typeof a.ticket_id === 'number' ? a.ticket_id : grant.ticket_id };
      let outcome: 'ok' | 'denied' | 'error' = 'ok';
      let text: string;
      try {
        if (!(grant.role in t.access)) throw new Deny(`a ${grant.role} may not call ${name}`);
        text = JSON.stringify(t.run(c, a), null, 2);
      } catch (e) {
        outcome = e instanceof Deny || e instanceof Refused ? 'denied' : 'error';
        text = (e as Error).message;
      }
      // audit.ticket_id is a FK: an attempt against a missing ticket is attributed by args only.
      const ticket = c.ticket !== null && exists(db, c.ticket) ? c.ticket : null;
      audit(db, { grant_id: grant.id, ticket_id: ticket, tool: name, args: a, outcome });
      if (outcome === 'ok') changed(ticket); // the UI refetches that ticket (notes, flags, a new card)
      return { content: [{ type: 'text', text }], ...(outcome === 'ok' ? {} : { isError: true }) };
    });
  }
}

const unauthorized = JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: a live bearer grant is required' }, id: null });

/** Mounted at /mcp. 401 before anything else when the bearer is missing, malformed, unknown, expired or revoked; no audit row, there is no grant to attribute. */
export async function handleMcp(board: Board, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { db } = board;
  const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
  const grant = m && verify(db, m[1]);
  if (!grant) {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(unauthorized) });
    res.end(unauthorized);
    return;
  }
  // ponytail: one stateless McpServer per request, closing over the grant. Sessions (GET streams, server pushes) when a tool needs them.
  const server = new McpServer({ name: 'kanban95', version: '0.0.0' });
  registerTools(server, board, grant);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1 << 20 });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
