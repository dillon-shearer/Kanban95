// The nudge: a Claude Code worker or tester that ended its turn with its ticket still open, on the fake `claude` (board.ts).
import './home.ts';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessions, sessionsOf, transcriptFile } from '../src/launcher.ts';
import { NUDGE, NUDGE_LINE, SILENCE } from '../src/lifecycle.ts';
import { db, models, notes, post, t, ticket, until } from './board.ts';

describe('the nudge', { timeout: 60_000 }, () => {
  const silence0 = { ...SILENCE };
  const nudge0 = { ...NUDGE };
  beforeAll(() => Object.assign(SILENCE, { every: 50 }));
  afterAll(() => Object.assign(SILENCE, silence0) && Object.assign(NUDGE, nudge0));
  const quiet = (ms: number) => Object.assign(NUDGE, { quiet: ms });
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const typed = (id: number) => (sessionsOf(id)[0]?.scrollback() ?? '').split(/\r?\n/).filter((l) => l.includes('TYPED ')).length;
  const started = async (id: number) => {
    await until(() => sessionsOf(id)[0]?.scrollback().includes('FAKE stops'), 'the fake agent to start', 20_000);
    const f = transcriptFile(sessionsOf(id)[0]);
    await until(() => f && /progress report/.test(readFileSync(f, 'utf8')), 'its first report');
    return f!;
  };

  it('a worker that ended its turn with no tool call, ticket in progress and unflagged, gets the worker line once the quiet period passes', async () => {
    quiet(600);
    const id = ticket('Stops', { model: 'stops' });
    await post(`/api/tickets/${id}/launch`);
    await started(id);
    await until(() => typed(id) >= 1, 'the nudge');
    expect(sessionsOf(id)[0].scrollback()).toContain(`TYPED ${NUDGE_LINE.worker}`);
    expect(t(id).status).toBe('in_progress');
  });

  it('a tester gets the line that names report_test', async () => {
    quiet(600);
    models({ test: 'stops' });
    const id = ticket('Tested');
    await post(`/api/tickets/${id}/launch`);
    await until(() => t(id).status === 'testing', 'the worker to submit');
    await until(() => typed(id) >= 1, 'the nudge', 20_000);
    expect(sessionsOf(id)[0].scrollback()).toContain(`TYPED ${NUDGE_LINE.tester}`);
  });

  it.each([
    ['a tool call', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }],
    ['a tool result', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }],
    ['a stop while a background command runs', null],
  ])('a transcript ending in %s gets no nudge', async (_, entry) => {
    quiet(60_000);
    const id = ticket('Busy', { model: 'stops' });
    await post(`/api/tickets/${id}/launch`);
    const f = await started(id);
    const lines = entry ? [entry] : [
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Command running in background with ID: b1.' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'waiting for it' }], stop_reason: 'end_turn' } },
    ];
    appendFileSync(f, lines.map((l) => JSON.stringify(l) + '\n').join(''));
    quiet(200);
    await pause(1500);
    expect(typed(id)).toBe(0);
    if (entry) return;
    appendFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: '<task-notification>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>' } }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done waiting' }], stop_reason: 'end_turn' } }) + '\n');
    await until(() => typed(id) >= 1, 'the nudge once the background command reported');
  });

  it.each([['a question', 'question', 'Which colour?'], ['a permission ask', 'question', 'PERMISSION level=1\nreason']])('a ticket flagged with %s gets no nudge', async (_, kind, body) => {
    quiet(400);
    const id = ticket('Waiting', { model: 'stops' });
    await post(`/api/tickets/${id}/launch`);
    db.prepare('UPDATE tickets SET needs_human = 1 WHERE id = ?').run(id);
    db.prepare("INSERT INTO notes (ticket_id, role, kind, body) VALUES (?, 'worker', ?, ?)").run(id, kind, body);
    await started(id);
    await pause(1500);
    expect(typed(id)).toBe(0);
  });

  it('after 2 nudges the third stop flags the ticket with a note, and no third line is typed', async () => {
    quiet(400);
    const id = ticket('Stuck', { model: 'stops' });
    await post(`/api/tickets/${id}/launch`);
    await started(id);
    await until(() => t(id).flags.needs_human, 'the flag', 20_000);
    expect(typed(id)).toBe(2);
    const [note] = notes(id, 'failure');
    expect(note).toMatch(/^agent stopped 3 times without finishing: it ended its turn with the ticket still open after 2 nudges\. Last lines of its terminal:\n```\n/);
    expect(sessionsOf(id)).toHaveLength(1);
    await pause(1500);
    expect(typed(id)).toBe(2);
    expect(notes(id, 'failure')).toHaveLength(1);
  });

  it('a brainstorm or operator terminal is never nudged', async () => {
    quiet(200);
    writeFileSync(join(process.env.USERPROFILE!, '.kanban95', 'models.json'), JSON.stringify({ cli: 'claude', claude: { plan: { model: 'stops', effort: 'low' }, operator: { model: 'stops', effort: 'low' } } }));
    const b = await (await post('/api/brainstorm')).json();
    const o = await (await post('/api/operator', { mission: 'go' })).json();
    const out = (k: number) => sessions.get(k)?.scrollback() ?? '';
    await until(() => out(b.id).includes('FAKE stops') && out(o.id).includes('FAKE stops'), 'both terminals');
    await pause(1500);
    expect(out(b.id)).not.toContain('TYPED');
    expect(out(o.id)).not.toContain('TYPED');
  });
});
