// Agent-facing MCP at /mcp. A bearer grant picks the role; TOOLS below is both the enforcement table and the source of docs/MCP.md.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';
import { brainAdd, brainDelete, brainGet, brains, brainSearch, brainUpdate, deleteTicket, normaliseTags, readTicket, setDeps, transaction } from './api.js';
import { BRAIN_BODY_MAX, SCOPES } from './db.js';
import { attachments } from './attachments.js';
import { audit, verify, type Grant, type Role } from './grants.js';
import { apply, changed, Refused, type Board } from './lifecycle.js';
import { EFFORT, uncatalogued } from './settings.js';

const STATUS = ['backlog', 'in_progress', 'testing', 'done'] as const;
/** Where each role may move a ticket: its own, or for the operator any. The planner never moves anything. */
const MOVE_TARGETS: Record<Role, readonly (typeof STATUS)[number][]> = {
  planner: [],
  worker: ['testing'],
  tester: ['done', 'in_progress'],
  operator: ['in_progress', 'testing', 'done'],
};
/** Grants without a ticket: they see the whole board and name the ticket on every ticket tool. */
const unbound = (r: Role) => r === 'planner' || r === 'operator';
const an = (r: Role) => `${r === 'operator' ? 'an' : 'a'} ${r}`;
/** The only ticket columns a worker may edit on its own ticket. */
const WORKER_FIELDS = ['body', 'criteria'] as const;
/** What a worker may edit on a follow-up its own grant created, while it is in Backlog. */
const FOLLOWUP_FIELDS = ['title', 'body', 'criteria', 'tags', 'depends_on'] as const;
const BRAIN_SEARCH_MAX = 50;
/** An id is per brain file, so a row is `scope` + `id`. */
const scope = z.enum(SCOPES).default('project')
  .describe('project (default): this repo\x27s brain, facts about this codebase. global: the brain every board shares, facts that hold in any repo (a tool, the OS, a CLI).');

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
  .describe('Ticket id. Worker and tester grants are bound to one ticket and may omit it; a planner or operator must give it.');

/** Resolves the ticket a call is about. Worker/tester: their own, a foreign id is a scope denial. Planner/operator: the explicit id. */
function own(c: Call, id: number | undefined): number {
  if (unbound(c.grant.role)) {
    if (id === undefined) throw new Error(`ticket_id is required for ${an(c.grant.role)} grant`);
    return id;
  }
  if (id !== undefined && id !== c.grant.ticket_id) throw new Deny(`this grant is scoped to ticket ${c.grant.ticket_id}`);
  return c.grant.ticket_id!;
}
const exists = (db: DatabaseSync, id: number) => db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(id) !== undefined;
/** A Backlog ticket this grant created: the only kind a worker may edit beyond its own, or delete. */
const followUp = (db: DatabaseSync, grant: Grant, id: number) =>
  db.prepare("SELECT 1 FROM tickets WHERE id = ? AND created_by_grant = ? AND status = 'backlog'").get(id, grant.id) !== undefined;
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
      'List depends_on ids when this work must wait for other tickets. Tags (lowercase a-z, 0-9, -) group related tickets on the board. Set model and effort only when the work clearly warrants it: trivial work gets effort low, hard work gets high. ' +
      'A worker files a follow-up or a manual touch it found this way instead of widening its own scope: it lands in Backlog, its body starts with "Filed by #<your ticket>", ' +
      'it runs on the operator\x27s default model and effort, and the worker may fix or delete it while it is still in Backlog. Returns the ticket.',
    access: { planner: 'yes', worker: 'yes, Backlog follow-up, no model/effort', operator: 'yes' },
    input: {
      title: z.string().min(1).describe('Short imperative title.'),
      body: z.string().default('').describe('What to build and why, markdown.'),
      criteria: z.string().default('').describe('Acceptance criteria, one checkable statement per line.'),
      depends_on: z.array(z.number().int().positive()).default([]).describe('Ticket ids that must be done before this one starts.'),
      tags: z.array(z.string()).optional().describe('Grouping tags, each lowercase a-z, 0-9 and - only, e.g. ["ui", "daemon"].'),
      model: z.string().min(1).optional().describe('Model override; omit for the phase default.'),
      effort: z.enum(EFFORT).optional().describe('Effort override; omit for the phase default.'),
    },
    run(c, a) {
      const worker = c.grant.role === 'worker';
      if (worker && (a.model !== undefined || a.effort !== undefined)) throw new Deny('a worker may not set model or effort; the follow-up runs on the operator\x27s defaults');
      const bad = a.model && uncatalogued(a.model);
      if (bad) throw new Error(bad);
      const body = worker ? `Filed by #${c.grant.ticket_id}\n\n${a.body}` : a.body;
      const tags = normaliseTags(a.tags ?? []);
      const id = transaction(c.db, () => {
        const r = c.db
          .prepare('INSERT INTO tickets (title, body, criteria, tags, model, effort, created_by_grant) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(a.title, body, a.criteria, tags, a.model ?? null, a.effort ?? null, c.grant.id);
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
      'Edit a ticket\'s title, body, criteria or dependencies. A worker may only refine the body and criteria of its own ticket, for example to record a clarified scope, ' +
      'and fix any of these fields on a Backlog follow-up it created with create_ticket; use add_note for progress and decisions instead. Omitted fields are left unchanged. Returns the ticket.',
    access: {
      planner: 'any ticket',
      worker: `own, ${WORKER_FIELDS.join('/')} only; its Backlog follow-ups, ${FOLLOWUP_FIELDS.join('/')}`,
      operator: 'any ticket',
    },
    input: {
      ticket_id: ticketId,
      title: z.string().min(1).optional(),
      body: z.string().optional(),
      criteria: z.string().optional(),
      tags: z.array(z.string()).optional().describe('Replaces the full tag list; [] clears it.'),
      depends_on: z.array(z.number().int().positive()).optional().describe('Replaces the full dependency list.'),
    },
    run(c, { ticket_id, depends_on, tags, ...rest }) {
      const cols: Record<string, unknown> = { ...rest, tags: tags && normaliseTags(tags) };
      // A worker's Backlog follow-up is the one foreign id it may name; any other goes through own() and its scope denial.
      const mine = c.grant.role === 'worker' && ticket_id !== undefined && followUp(c.db, c.grant, ticket_id);
      const id = (c.ticket = mine ? ticket_id : own(c, ticket_id));
      const given = Object.keys(cols).filter((k) => cols[k] !== undefined);
      if (depends_on) given.push('depends_on');
      if (given.length === 0) throw new Error('nothing to update');
      if (c.grant.role === 'worker' && !mine) {
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

  delete_ticket: tool({
    description:
      'Delete a Backlog ticket made by mistake, with its attachments, exactly as the operator\x27s delete does. A planner may delete a Backlog ticket that has no notes and no runs; ' +
      'a worker may delete only a Backlog follow-up its own grant created with create_ticket. Anything else is refused with the reason. Returns the deleted id.',
    access: { planner: 'Backlog, no notes or runs', worker: 'its Backlog follow-ups', operator: 'Backlog, no notes or runs' },
    input: { ticket_id: z.number().int().positive() },
    run(c, a) {
      const id = (c.ticket = a.ticket_id);
      const t = readTicket(c.db, id);
      if (c.grant.role === 'worker' && t.created_by_grant !== c.grant.id) throw new Deny(`a worker may only delete a ticket its own grant created; ticket ${id} is not one`);
      if (t.status !== 'backlog') throw new Deny(`ticket ${id} is in ${t.status}; only a Backlog ticket can be deleted here`);
      if (c.grant.role !== 'worker') {
        const count = (table: 'notes' | 'runs') => (c.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ticket_id = ?`).get(id) as { n: number }).n;
        if (count('notes')) throw new Deny(`ticket ${id} has notes; only the operator can delete it, from the board`);
        if (count('runs')) throw new Deny(`ticket ${id} has runs; only the operator can delete it, from the board`);
      }
      deleteTicket(c.board, id);
      return { id };
    },
  }),

  set_model: tool({
    description:
      'Change the model and/or effort a ticket runs with; give either or both. Lower effort for trivial work and raise it for hard work, do not only escalate. ' +
      'The ticket\x27s model and effort apply to all its execute runs, retries included. Returns the ticket.',
    access: { planner: 'any', operator: 'any' },
    input: {
      ticket_id: ticketId,
      model: z.string().min(1).optional().describe('Model id as listed in the board\'s model catalog.'),
      effort: z.enum(EFFORT).optional(),
    },
    run(c, a) {
      const id = (c.ticket = own(c, a.ticket_id));
      if (a.model === undefined && a.effort === undefined) throw new Error('give model and/or effort');
      const t = readTicket(c.db, id);
      const bad = a.model !== undefined && uncatalogued(a.model, t.cli);
      if (bad) throw new Error(bad);
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
      'A tester does not need it: report_test moves the ticket (to done or back to in_progress) and ends the session. ' +
      'A move to the column the ticket is already in returns the ticket unchanged. ' +
      'Once the move is accepted your session is over: the board ends it and starts the next agent. ' +
      'An operator grant may move any ticket the same ways, which ends that ticket\x27s agent, not its own session, and may launch a backlog ticket by moving it to in_progress; ' +
      'it still cannot finish a ticket the tester has not passed. Returns the ticket.',
    access: {
      worker: `own → ${MOVE_TARGETS.worker.join(' / ')}`,
      tester: `own → ${MOVE_TARGETS.tester.join(' / ')}`,
      operator: `any → ${MOVE_TARGETS.operator.join(' / ')}`,
    },
    input: { ticket_id: ticketId, status: z.enum(STATUS) },
    run(c, a) {
      const id = (c.ticket = own(c, a.ticket_id));
      const allowed = MOVE_TARGETS[c.grant.role];
      if (!allowed.includes(a.status)) throw new Deny(`${an(c.grant.role)} may only move ${c.grant.role === 'operator' ? 'a' : 'its'} ticket to: ${allowed.join(', ')}`);
      // Into in_progress: from backlog it is a launch (only an operator reaches a backlog ticket), from testing a failed test.
      const from = readTicket(c.db, id).status;
      // Already there (a tester whose report_test moved it, then followed the old two-step script): nothing to do.
      if (from === a.status) return readTicket(c.db, id);
      return apply(c.board, id, a.status === 'testing' ? 'submit' : a.status === 'done' ? 'pass' : from === 'backlog' ? 'launch' : 'fail').ticket;
    },
  }),

  add_note: tool({
    description:
      'Attach a note to a ticket. Kinds: plan (how you intend to do the work, post it before starting), decision (a choice made and why), ' +
      'failure (what went wrong, for the next attempt), summary (what was done, post it when finished). Notes are shown to the operator and injected into later runs of this ticket. Returns the note id.',
    access: { planner: 'any', worker: 'own', tester: 'own', operator: 'any' },
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
      'A worker or tester may also read the tickets its own ticket depends on, to see what they delivered or decided.',
    access: { planner: 'yes', worker: 'own + its deps', tester: 'own + its deps', operator: 'yes' },
    input: { ticket_id: ticketId },
    run(c, a) {
      const { grant } = c;
      const id = unbound(grant.role) ? own(c, a.ticket_id) : (a.ticket_id ?? grant.ticket_id!);
      c.ticket = id;
      const visible = unbound(grant.role) || id === grant.ticket_id || depsOf(c.db, grant.ticket_id!).includes(id);
      if (!visible) throw new Deny(`this grant is scoped to ticket ${grant.ticket_id} and its dependencies`);
      const ticket = readTicket(c.db, id);
      const notes = c.db.prepare('SELECT id, role, kind, body, created_at FROM notes WHERE ticket_id = ? ORDER BY id').all(id);
      return { ...ticket, attachments: attachments(c.board.repo, id).map((f) => f.path), notes };
    },
  }),

  list_tickets: tool({
    description:
      'List tickets with id, title, status, tags, flags and dependencies, optionally filtered by status. A planner or operator sees the whole board; ' +
      'a worker or tester sees its own ticket and the ones it depends on. Use get_ticket for the body and notes.',
    access: { planner: 'yes', worker: 'own + its deps', tester: 'own + its deps', operator: 'yes' },
    input: { status: z.enum(STATUS).optional() },
    run(c, a) {
      const { grant } = c;
      let ids: number[];
      if (unbound(grant.role)) ids = (c.db.prepare('SELECT id FROM tickets ORDER BY id').all() as { id: number }[]).map((r) => r.id);
      else ids = [grant.ticket_id!, ...depsOf(c.db, grant.ticket_id!)];
      return ids
        .map((id) => readTicket(c.db, id))
        .filter((t) => a.status === undefined || t.status === a.status)
        .map(({ id, title, status, tags, flags, depends_on }) => ({ id, title, status, tags, flags, depends_on }));
    },
  }),

  brain_add: tool({
    description:
      'Save one fact a future agent would trip on to the brain: a gotcha, a non-obvious decision, or how an external tool behaves (with version and date). ' +
      'Gate: write a row only if it passes all three questions; a row failing any one is not written. ' +
      '1 Quality: would a future agent trip without it, and can a reader with no context act on it (what, why, what to do, where)? Not a plan, not ticket status, not what the code, docs or templates say. ' +
      '2 Scope: holds in every repo (a tool, CLI, OS or model behaviour, with version and date) → global; only this codebase → project; unsure → project. ' +
      '3 Worth: would anyone search for it, or is it a one-off that bloats the brain? ' +
      'brain_search the subject first; if a row already covers it, correct that row with brain_update instead of adding a near-duplicate. ' +
      'Title: a sentence naming the trap ("X does Y; do Z"). Body: what happens, why, what to do instead, and the file or function, for a reader with no context. ' +
      'Tags: words the title of a future ticket would contain. Never write ticket status or plans ("pending", "until #N merges"): they go stale; unbuilt work belongs in a ticket. ' +
      'Skip what the code, docs or templates already say. Returns the brain row id and scope.',
    access: { planner: 'yes', worker: 'yes', tester: 'yes', operator: 'yes' },
    input: {
      title: z.string().min(1),
      body: z.string().min(1).max(BRAIN_BODY_MAX).describe(`Markdown, at most ${BRAIN_BODY_MAX} characters.`),
      tags: z.string().default('').describe('Space-separated keywords used for matching.'),
      scope,
    },
    run(c, { scope: s, ...f }) {
      const r = brainAdd(brains(c.board), s, f, c.grant.ticket_id);
      return { id: r.id, scope: r.scope };
    },
  }),

  brain_update: tool({
    description:
      'Correct a brain row in place: when your change made it false, when it duplicates what you were about to add, or to merge rows (edit the survivor; ask for the rest to be deleted in your summary). ' +
      'Name the row by scope and id, as brain_search returned them. Omitted fields are left unchanged. move_to moves the row to the other brain under a new id. Returns the row.',
    access: { planner: 'yes, and move_to', worker: 'yes, not move_to', tester: 'yes, not move_to', operator: 'yes, and move_to' },
    input: {
      id: z.number().int().positive(),
      scope,
      title: z.string().min(1).optional(),
      body: z.string().min(1).max(BRAIN_BODY_MAX).optional().describe(`Markdown, at most ${BRAIN_BODY_MAX} characters.`),
      tags: z.string().optional(),
      move_to: z.enum(SCOPES).optional().describe('Move the row to this brain (insert there, delete here).'),
    },
    run(c, { id, scope: s, move_to, ...fields }) {
      if (move_to !== undefined && move_to !== s && !unbound(c.grant.role)) throw new Deny(`${an(c.grant.role)} may not move a brain row between scopes: name it in your summary note`);
      return brainUpdate(brains(c.board), s, id, fields, move_to);
    },
  }),

  brain_delete: tool({
    description: 'Delete a brain row (scope and id) that is stale or duplicates another row or the docs. Workers and testers update rows instead and name the ones to delete in their summary note. Returns the deleted id and scope.',
    access: { planner: 'yes', operator: 'yes' },
    input: { id: z.number().int().positive(), scope },
    run(c, a) {
      brainDelete(brains(c.board), a.scope, a.id);
      return { id: a.id, scope: a.scope };
    },
  }),

  brain_search: tool({
    description:
      'Full-text search the project brain and the global brain together, best match first (title and tags weigh more than the body); every row carries its scope. ' +
      'Search before making a decision another ticket may already have made, before brain_add, ' +
      'and when you meet an unfamiliar subsystem. Give `id` (with its scope) instead to fetch one row, such as one your prompt listed by title only; give neither to list the newest rows. ' +
      `Returns up to limit rows (default 5, max ${BRAIN_SEARCH_MAX}) with scope, title, body and tags.`,
    access: { planner: 'yes', worker: 'yes', tester: 'yes', operator: 'yes' },
    input: {
      query: z.string().min(1).optional().describe('Keywords; each word must match.'),
      id: z.number().int().positive().optional().describe('Fetch this one row instead of searching.'),
      scope: scope.describe('With id: which brain the row is in. Ignored by a search, which covers both.'),
      limit: z.number().int().min(1).max(BRAIN_SEARCH_MAX).default(5),
    },
    run(c, a) {
      if (a.id !== undefined) return [brainGet(brains(c.board), a.scope, a.id)].filter(Boolean);
      return brainSearch(brains(c.board), a.query ?? '', a.limit);
    },
  }),

  ask_operator: tool({
    description:
      'Ask the human operator a question you cannot resolve from the ticket, the brain or the code. The ticket is flagged needs_human and the operator is alerted; ' +
      'the answer is typed into your session as one line and kept as a note on the ticket. Ask once with full context and the options you see, rather than many small questions. Returns the question id.',
    access: { worker: 'own', tester: 'own' },
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
      'evidence lists what proves it, one string per item (test output, screenshot paths kept as run evidence, commands run); a single string is taken as one item. The report is the verdict: it moves the ticket to done (the board merges the branch) ' +
      'or back to in_progress (the worker retries, and a failed report becomes the failure note it sees), and ends your session. No move_ticket is needed. Returns the note id and the ticket.',
    access: { tester: 'own' },
    input: {
      ticket_id: ticketId,
      passed: z.boolean(),
      summary: z.string().min(1),
      // A string is taken as one item: agents passed one 42 times in 28 tickets and had to repeat the call.
      evidence: z.union([z.array(z.string().min(1)), z.string().min(1)]).default([]),
    },
    run(c, a) {
      const id = (c.ticket = own(c, a.ticket_id));
      const { status } = readTicket(c.db, id);
      // Checked before the note is written, so a refused verdict leaves nothing behind.
      if (status !== 'testing') throw new Refused(`cannot report a test on a ticket in ${status}`);
      const body = [`${a.passed ? 'PASS' : 'FAIL'}: ${a.summary}`, ...[a.evidence].flat().map((e) => `- ${e}`)].join('\n');
      const { note_id } = addNote(c, id, a.passed ? 'summary' : 'failure', body);
      // The report is the verdict: it drives the move, so a tester that stops after reporting cannot strand the ticket in Testing.
      return { note_id, ticket: apply(c.board, id, a.passed ? 'pass' : 'fail').ticket };
    },
  }),

  report_cleanup: tool({
    description:
      'Record what a housekeeping ticket removed or updated: one item per file or module with the action and the reason (superseded by X, no importers, references removed code). ' +
      'Used by housekeeping tickets, and by an operator grant on any ticket; the list is shown to the operator and kept with the ticket. Returns the note id.',
    access: { worker: 'own', operator: 'any' },
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
        if (!(grant.role in t.access)) throw new Deny(`${an(grant.role)} may not call ${name}`);
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
