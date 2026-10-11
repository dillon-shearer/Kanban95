// The transition table (docs/LIFECYCLE.md), checked row by row with no daemon. The lifecycle end to end, on a fake `claude`,
// is in the lifecycle-*.test.ts files (setup in board.ts).
import { describe, expect, it } from 'vitest';
import { worktreePath } from '../src/git.ts';
import { MAX_RETRY, Refused, TABLE, TO_RESOLVE, transition, type Event, type Facts, type Status } from '../src/lifecycle.ts';

/** A path as a literal inside a RegExp. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('transition table', () => {
  const f = (o: Partial<Facts>): Facts => ({ status: 'backlog', needs_human: false, retry: 0, merged: false, depsMerged: true, passReported: false, live: true, ...o });
  // Written out by hand from docs/LIFECYCLE.md, not derived from TABLE, so a changed row fails here.
  const rows: [string, Partial<Facts>, Event, ReturnType<typeof transition>][] = [
    ['launch, deps merged', { status: 'backlog' }, 'launch', { to: 'in_progress', set: { blocked_on_deps: 0 }, effects: ['spawn_execute'] }],
    ['launch, deps not merged', { status: 'backlog', depsMerged: false }, 'launch', { to: 'backlog', set: { blocked_on_deps: 1 }, effects: [] }],
    ['launch on a running ticket whose agent is gone', { status: 'in_progress', live: false, needs_human: true }, 'launch', { to: 'in_progress', set: { needs_human: 0 }, effects: ['spawn_execute'] }],
    ['launch on a testing ticket whose agent is gone', { status: 'testing', live: false }, 'launch', { to: 'testing', set: { needs_human: 0 }, effects: ['spawn_test'] }],
    ['resume a flagged ticket in progress', { status: 'in_progress', live: false, needs_human: true, retry: 2 }, 'resume', { to: 'in_progress', set: { needs_human: 0 }, effects: ['spawn_execute'] }],
    ['resume a flagged ticket in testing', { status: 'testing', live: false, needs_human: true }, 'resume', { to: 'testing', set: { needs_human: 0 }, effects: ['spawn_test'] }],
    ['restart a live ticket in progress', { status: 'in_progress', retry: 2 }, 'restart', { to: 'in_progress', set: { needs_human: 0 }, effects: ['end_session', 'note', 'spawn_execute'] }],
    ['restart a flagged ticket in testing with no agent', { status: 'testing', live: false, needs_human: true }, 'restart', { to: 'testing', set: { needs_human: 0 }, effects: ['end_session', 'note', 'spawn_test'] }],
    ['worker submits', { status: 'in_progress' }, 'submit', { to: 'testing', set: {}, effects: ['end_session', 'spawn_test'] }],
    ['tester passes after report_test(pass)', { status: 'testing', passReported: true }, 'pass', { to: 'done', set: { merged: false }, effects: ['end_session', 'done', 'enqueue_merge'] }],
    ['first failure', { status: 'testing', retry: 0 }, 'fail', { to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'spawn_execute'] }],
    ['third failure is the last retry', { status: 'testing', retry: MAX_RETRY - 1 }, 'fail', { to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'spawn_execute'] }],
    ['fourth failure stops', { status: 'testing', retry: MAX_RETRY }, 'fail', { to: 'in_progress', set: { retry: '+1', needs_human: 1 }, effects: ['end_session', 'note', 'chord'] }],
    ['worker asks', { status: 'in_progress' }, 'ask', { to: 'in_progress', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['tester asks', { status: 'testing' }, 'ask', { to: 'testing', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['operator answers', { status: 'in_progress', needs_human: true }, 'answer', { to: 'in_progress', set: { needs_human: 0 }, effects: ['note', 'answer_pty'] }],
    ['worker exits silently', { status: 'in_progress' }, 'exit', { to: 'in_progress', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['tester exits silently', { status: 'testing', live: false }, 'exit', { to: 'testing', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['a live worker goes silent', { status: 'in_progress' }, 'silent', { to: 'in_progress', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['a live tester goes silent', { status: 'testing' }, 'silent', { to: 'testing', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['a silent agent writes again', { status: 'in_progress', needs_human: true }, 'woke', { to: 'in_progress', set: { needs_human: 0 }, effects: [] }],
    ['merge ok', { status: 'done' }, 'merged', { to: 'done', set: { merged: true, needs_human: 0 }, effects: ['ding', 'remove_worktree', 'release_dependents', 'housekeeping'] }],
    ['base will not merge in on submit: back to the worker', { status: 'in_progress', retry: 0 }, 'conflict', { to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'note', 'spawn_execute'] }],
    ['base will not merge in on submit at the retry cap stops', { status: 'in_progress', retry: MAX_RETRY }, 'conflict', { to: 'in_progress', set: { needs_human: 1 }, effects: ['end_session', 'note', 'chord'] }],
    ['merge conflict goes back to the worker', { status: 'done', retry: MAX_RETRY - 1 }, 'conflict', { to: 'in_progress', set: { retry: '+1' }, effects: ['end_session', 'note', 'spawn_execute'] }],
    ['merge conflict at the retry cap stops', { status: 'done', retry: MAX_RETRY }, 'conflict', { to: 'done', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['base still dirty after the wait', { status: 'done' }, 'dirty', { to: 'done', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['merged but the push failed', { status: 'done' }, 'unpushed', { to: 'done', set: { needs_human: 1 }, effects: ['note', 'chord'] }],
    ['operator rejects a merged ticket', { status: 'done', merged: true, retry: 2, live: false }, 'reject', { to: 'in_progress', set: { needs_human: 0, retry: 0 }, effects: ['note', 'spawn_execute'] }],
    ['operator rejects a flagged unmerged ticket', { status: 'done', needs_human: true, live: false }, 'reject', { to: 'in_progress', set: { needs_human: 0, retry: 0 }, effects: ['note', 'spawn_execute'] }],
    ['operator retries a failed merge', { status: 'done', needs_human: true }, 'merge', { to: 'done', set: {}, effects: ['enqueue_merge'] }],
  ];
  it.each(rows)('%s', (_, facts, event, want) => {
    expect(transition(f(facts), event)).toEqual(want);
  });

  const allowed: Record<Status, Event[]> = {
    backlog: ['launch'],
    in_progress: ['launch', 'resume', 'restart', 'submit', 'ask', 'answer', 'exit', 'silent', 'woke', 'conflict'],
    testing: ['launch', 'resume', 'restart', 'pass', 'fail', 'ask', 'answer', 'exit', 'silent', 'woke'],
    done: ['merged', 'conflict', 'merge', 'dirty', 'unpushed', 'reject'],
  };
  const EVENTS: Event[] = ['launch', 'submit', 'pass', 'fail', 'ask', 'answer', 'exit', 'silent', 'woke', 'merged', 'conflict', 'merge', 'dirty', 'unpushed', 'resume', 'restart', 'reject'];
  it('refuses every other event in every status', () => {
    let n = 0;
    for (const status of Object.keys(allowed) as Status[]) {
      for (const event of EVENTS.filter((e) => !allowed[status].includes(e))) {
        expect(() => transition(f({ status }), event), `${status} ${event}`).toThrow(Refused);
        n++;
      }
    }
    expect(n).toBe(4 * EVENTS.length - 27);
  });

  it('refuses a guarded row whose guard fails, saying why', () => {
    expect(() => transition(f({ status: 'testing' }), 'pass')).toThrow('cannot pass a ticket in testing: call report_test with passed: true first');
    expect(() => transition(f({ status: 'testing', needs_human: false }), 'answer')).toThrow(/no flagged question/);
    expect(() => transition(f({ status: 'testing', needs_human: true, live: false }), 'answer')).toThrow(/no flagged question/);
    expect(() => transition(f({ status: 'done', merged: true }), 'merge')).toThrow('cannot merge a ticket in done: already merged');
    expect(() => transition(f({ status: 'done', live: true }), 'reject')).toThrow('cannot reject a ticket in done: it already has a running agent');
    const busy = 'it already has a running agent; open its terminal, or Reset to Backlog to stop it';
    expect(() => transition(f({ status: 'in_progress', needs_human: true }), 'launch')).toThrow(`cannot launch a ticket in in_progress: ${busy}`);
    expect(() => transition(f({ status: 'testing', needs_human: true }), 'resume')).toThrow(`cannot resume a ticket in testing: ${busy}`);
    expect(() => transition(f({ status: 'in_progress', live: false }), 'resume')).toThrow('cannot resume a ticket in in_progress: it is not flagged');
    expect(() => transition(f({ status: 'backlog', needs_human: true, live: false }), 'resume')).toThrow('cannot resume a ticket in backlog');
    expect(() => transition(f({ status: 'done', needs_human: true, live: false }), 'resume')).toThrow('cannot resume a ticket in done');
    expect(() => transition(f({ status: 'in_progress', needs_human: true }), 'silent')).toThrow('cannot silent a ticket in in_progress: it has no running agent, or it is flagged already');
    expect(() => transition(f({ status: 'testing', live: false }), 'silent')).toThrow(/no running agent/);
    expect(() => transition(f({ status: 'in_progress' }), 'woke')).toThrow(/it is not flagged/);
  });

  it('every row that raises needs_human writes one note, and all but a question end it with what resolves it', () => {
    const flagged = TABLE.filter((r) => r.set?.needs_human === 1);
    expect(flagged.map((r) => r.event)).toEqual(['fail', 'ask', 'exit', 'silent', 'conflict', 'conflict', 'dirty', 'unpushed']);
    for (const r of flagged) {
      expect(r.effects.filter((e) => e === 'note'), r.event).toHaveLength(1);
      expect(r.resolve === undefined, r.event).toBe(r.event === 'ask');
    }
    const fix = (e: Event, from: Status = 'done') => flagged.find((r) => r.event === e && r.from.includes(from))!.resolve!(7, 'C:/repo');
    expect(fix('conflict')).toMatch(new RegExp(`^in ${esc(worktreePath('C:/repo', 7))} .*Retry merge`));
    expect(fix('conflict', 'in_progress')).toMatch(new RegExp(`^in ${esc(worktreePath('C:/repo', 7))} .*uncommitted .*git merge .*Resume`));
    expect(fix('dirty')).toMatch(/main checkout \(C:\/repo\).*Retry merge/);
    expect(fix('unpushed')).toMatch(/main checkout \(C:\/repo\).*pull .*sign in .*Retry merge/);
    expect(`To resolve: ${fix('exit', 'in_progress')}`).toBe(TO_RESOLVE);
  });
});
