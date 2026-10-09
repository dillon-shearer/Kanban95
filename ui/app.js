// Kanban95 UI: the data layer over /api and the /events websocket, and the windows built on it (Board, Ticket, Terminal,
// Brain, Settings, Inbox). An event names one ticket (or, with null, the set of live sessions); each open window redraws
// only when the event concerns it. Nothing here reloads the page.
import { FitAddon } from './vendor/xterm/addon-fit.mjs';
import { Terminal } from './vendor/xterm/xterm.mjs';
import { configure, ensureModel, micButton, micEverywhere } from './voice.js';
import * as ui from './state.js';
import { close, dialog, focus, focused, forget, h, isOpen, menu, open, raise, scale, seed, setTiling, setZoom, snapshot } from './wm.js';

// ---- data ----

async function api(method, path, body) {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = r.status === 204 ? null : await r.json();
  if (!r.ok) throw Object.assign(new Error(j?.error ?? r.statusText), { status: r.status });
  return j;
}

const COLUMNS = [['backlog', 'Backlog'], ['in_progress', 'In Progress'], ['testing', 'Testing'], ['done', 'Done']];
const LABEL = Object.fromEntries(COLUMNS);
const EFFORTS = ['low', 'medium', 'high', 'max'];
const PHASES = ['plan', 'execute', 'test', 'operator'];
const CLIS = ['claude', 'codex'];
/** Where the operator may drag a ticket. Everything onward is the agents' job; anything may go back to Backlog (reset). */
const MOVES = { backlog: ['in_progress'], in_progress: ['backlog'], testing: ['backlog'], done: ['backlog'] };

const tickets = new Map();
let sessions = [];
let inbox = [];
let runner = { on: false, concurrency: 3, running: [], left: 0, backlog: 0, waits: [], unpushed: 0 }; // GET /api/runner: the Run button and its status-bar line
let models = null; // ~/.kanban95/models.json as written, for the cards' default model and effort
// Sounds stay off until /config/settings loads: listen() starts first, and a ding in that gap ignored the operator's choice.
// `terminals` is absent until then too, so no session is opened or passed over before the operator's phases are known.
let settings = { paths: {}, sounds: { merge: false, attention: false }, voice: { backend: 'local', mode: 'push' }, housekeeping: { auto: true, every: 10 }, idle_minutes: 20, zoom: 1, push_after_merge: true };
let limits = null; // GET /api/limits: { rows, errors, fetched_at }, null until the first answer
const views = new Map(); // open window id → redraw(ticketId | null)

async function refreshTicket(id) {
  try {
    const was = tickets.get(id)?.flags.needs_human;
    const t = await api('GET', `/tickets/${id}`);
    tickets.set(id, t);
    for (const term of terms.values()) if (term.s.ticket_id === id) term.paint();
    // Reset to Backlog: the daemon stopped its agents, and their terminals, live or already "(ended)", close with it.
    if (t.status === 'backlog') for (const [wid, term] of terms) if (term.s.ticket_id === id) close(wid);
    if (t.flags.needs_human && !was) say(await flagReason(id));
  } catch (e) {
    if (e.status !== 404) throw e;
    tickets.delete(id); // deleted: it leaves the board, and its windows close (its agents were stopped by the delete)
    selection.delete(id);
    close(`ticket-${id}`);
    for (const [wid, term] of terms) if (term.s.ticket_id === id) close(wid);
  }
}
async function refreshShared() {
  [sessions, inbox, runner] = await Promise.all([api('GET', '/sessions'), api('GET', '/inbox'), api('GET', '/runner')]);
  openNewTerminals();
  taskbar();
}
const redraw = (ticket) => views.forEach((f) => f(ticket));

const SOUND_SETTING = { ding: 'merge', chord: 'attention' };

function listen() {
  const ws = new WebSocket(`ws://${location.host}/events`);
  ws.onmessage = async (m) => {
    const e = JSON.parse(m.data);
    if (e.sound) {
      if (settings.sounds[SOUND_SETTING[e.sound]]) new Audio(`sounds/${e.sound}.wav`).play().catch(() => {});
      // The chord's reason is said by refreshTicket when it first sees the flag, so the later change event does not repeat it.
      if (e.sound === 'chord' && e.ticket != null) await refreshTicket(e.ticket);
      else if (e.sound === 'ding' && e.ticket != null) say(`#${e.ticket} merged.`);
      return;
    }
    if (e.ticket != null) await refreshTicket(e.ticket);
    await refreshShared();
    redraw(e.ticket);
  };
  // Only Restart board reconnects: the shell navigates this window to the new daemon, which reloads the page.
  ws.onclose = () => {
    if (!restarting) return say('Lost the connection to the daemon. Restart Kanban95.');
    say('Restarting…');
    setTimeout(listen, 1000);
  };
}
let restarting = false;

// ---- board ----

// The Board's selection. Every card action takes the selected tickets, so a new bulk action is one more menu item.
const selection = new Set();
let anchor = null; // the last clicked card, where a Shift+click range starts
const picked = () => [...selection].map((id) => tickets.get(id)).filter((t) => t && shown(t) && !collapsed.has(t.status)); // a card the filter or a folded column hides is never acted on

function pick(t, e) {
  if (e.shiftKey && tickets.get(anchor)?.status === t.status) {
    const ids = order.get(t.status) ?? []; // the column as drawn: filtered and sorted
    const [a, b] = [ids.indexOf(anchor), ids.indexOf(t.id)].sort((x, y) => x - y);
    selection.clear();
    for (const id of ids.slice(a, b + 1)) selection.add(id);
  } else {
    if (!e.ctrlKey) selection.clear();
    if (e.ctrlKey && selection.has(t.id)) selection.delete(t.id);
    else selection.add(t.id);
    anchor = t.id;
  }
  drawBoard();
}
let say = (msg) => console.log(msg); // the Board's status bar while it is open

const defaults = (t) => models?.[t.cli ?? models.cli]?.execute ?? {};
const badge = (text, cls = '') => h('span', { class: `badge ${cls}` }, text);
const live = (ticketId) => sessions.filter((s) => s.ticket_id === ticketId);

function card(t) {
  const d = defaults(t);
  const el = h('div', {
    class: `card${selection.has(t.id) ? ' selected' : ''}${t.flags.needs_human ? ' alert' : ''}`, 'data-id': t.id, tabindex: 0,
    onclick: (e) => pick(t, e),
    ondblclick: () => openTicket(t.id),
    oncontextmenu: (e) => {
      e.preventDefault();
      if (!selection.has(t.id)) pick(t, {});
      cardMenu(picked(), e.clientX, e.clientY);
    },
  },
  h('div', { class: 'card-title' }, h('b', {}, `#${t.id}`), ' ', t.title),
  h('div', { class: 'badges' },
    badge(t.model ?? d.model ?? 'no model', t.model ? '' : 'default'),
    badge(t.effort ?? d.effort ?? 'medium', t.effort ? '' : 'default'),
    badge(t.cli ?? models?.cli ?? 'cli?', t.cli ? '' : 'default'),
    ...(t.tags ? t.tags.split(' ').map((g) => badge(g, 'tag')) : []),
    t.template === 'housekeeping' && badge('housekeeping'),
    live(t.id).length > 0 && badge('running', 'run'),
    t.flags.needs_human && badge('needs human', 'flag'),
    t.flags.blocked_on_deps && badge(`waits on #${t.depends_on.join(', #')}`, 'hold'),
    t.retry > 0 && badge(`retry ${t.retry}`),
    t.merged_at && badge('merged')));
  dragCard(el, t);
  return el;
}

/** Pointer drag: a ghost follows the pointer; on release over a column the move is checked, otherwise the card stays. */
function dragCard(el, t) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    let ghost = null;
    const move = (m) => {
      if (!ghost && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 5) return;
      if (!ghost) {
        ghost = el.cloneNode(true);
        ghost.classList.add('ghost');
        ghost.style.width = `${el.offsetWidth}px`;
        document.body.append(ghost);
        el.classList.add('dragging');
      }
      Object.assign(ghost.style, { left: `${m.clientX / scale() - 16}px`, top: `${m.clientY / scale() - 8}px` });
    };
    const up = (u) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!ghost) return;
      ghost.remove();
      el.classList.remove('dragging');
      const col = document.elementFromPoint(u.clientX, u.clientY)?.closest('[data-status]');
      if (col) drop(t, col.dataset.status);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

async function drop(t, to) {
  if (to === t.status) return;
  const allowed = MOVES[t.status];
  if (!allowed.includes(to)) {
    return say(`#${t.id} cannot be dragged from ${LABEL[t.status]} to ${LABEL[to]}. Allowed: ${allowed.map((s) => LABEL[s]).join(', ')}.`);
  }
  if (to === 'backlog') return reset([t]);
  await act(() => api('PATCH', `/tickets/${t.id}`, { status: to }), `#${t.id} moved to ${LABEL[to]} by hand; no agent was started.`);
}

/** Back to Backlog, flags and retries cleared. The daemon stops a running agent on the move, so its exit flags nothing. */
async function reset(ts) {
  const running = ts.filter((t) => live(t.id).length);
  const ask = ts.length > 1
    ? `Reset ${count(ts)} to Backlog?${running.length ? ` ${count(running)} with a running agent will be stopped.` : ''}`
    : running.length && `#${ts[0].id} has a running agent. Stop it and move the ticket to Backlog?`;
  if (ask && (await dialog('Reset to Backlog', ask, ['Reset', 'Cancel'])) !== 'Reset') return;
  await each(ts, (t) => api('PATCH', `/tickets/${t.id}`, { status: 'backlog', needs_human: false, blocked_on_deps: false, retry: 0 }), (n) => `${n} reset to Backlog.`);
}

/** Clears blocked_on_deps only: retry, notes and status stay (docs/LIFECYCLE.md → Cancel wait). */
const cancelWait = (ts) => each(ts, (t) => api('PATCH', `/tickets/${t.id}`, { blocked_on_deps: false }), (n) => `${n} no longer waiting.`);
const heldTickets = () => [...tickets.values()].filter((t) => t.status === 'backlog' && t.flags.blocked_on_deps);
async function cancelWaiting() {
  const ts = heldTickets();
  if (!ts.length) return say('Nothing is waiting to launch.');
  const ask = h('div', {}, h('p', {}, `Stop ${ts.length === 1 ? 'this ticket' : `these ${ts.length} tickets`} from launching by themselves when ${ts.length === 1 ? 'its' : 'their'} dependencies merge?`),
    h('ul', {}, ts.map((t) => h('li', {}, `#${t.id} ${t.title}`))));
  if ((await dialog('Cancel waiting', ask, ['Clear holds', 'Cancel'])) === 'Clear holds') await cancelWait(ts);
}

const count = (ts) => (ts.length === 1 ? `#${ts[0].id}` : `${ts.length} tickets`);
/** Runs fn on each ticket in turn; one that refuses is named and the rest still go. Says the outcome once. */
async function each(ts, fn, ok) {
  const done = [];
  const refused = [];
  for (const t of ts) {
    try {
      await fn(t);
      done.push(t);
    } catch (e) {
      refused.push(`#${t.id} refused: ${e.message}`);
    }
  }
  say([done.length && ok(count(done)), ...refused].filter(Boolean).join(' '));
}

async function act(fn, ok) {
  try {
    await fn();
    if (ok) say(ok);
  } catch (e) {
    say(e.message);
  }
}

// Why a card is red: its newest failure or question note. The status bar shows it the moment the card turns red.
async function flagReason(id) {
  const n = (await api('GET', `/tickets/${id}/notes`)).findLast((x) => x.kind === 'failure' || x.kind === 'question');
  return `#${id} needs you: ${n ? n.body.replace(/\s+/g, ' ') : 'open the ticket for details'}`;
}
// A launch can be refused at once (no models, dirty base); the refusal then wins over "launched".
async function sayLaunched(ids, more = []) {
  for (const id of ids) await refreshTicket(id);
  const flagged = ids.find((id) => tickets.get(id)?.flags.needs_human);
  const head = flagged != null ? await flagReason(flagged) : ids.length ? `Launched ${ids.map((id) => `#${id}`).join(', ')}.` : more.length ? '' : 'Nothing in Backlog.';
  say([head, ...more].filter(Boolean).join(' '));
}
// A running ticket whose agent is gone: the agent for its phase starts again in the same worktree (Launch does the same).
const resumable = (t) => (t.status === 'in_progress' || t.status === 'testing') && t.flags.needs_human && !live(t.id).length;
const launchable = (t) => t.status === 'backlog' || resumable(t);
/** Launches (or resumes) each ticket that can start; the rest are skipped and counted, and a refusal is named. */
async function launch(ts, verb = 'launch') {
  const go = ts.filter(verb === 'launch' ? launchable : resumable);
  if (!go.length) return say(verb === 'launch' ? 'Select a Backlog ticket first.' : 'Nothing to resume.');
  const ok = [];
  const more = [];
  for (const t of go) await api('POST', `/tickets/${t.id}/${verb}`).then(() => ok.push(t.id), (e) => more.push(`#${t.id} refused: ${e.message}`));
  if (go.length < ts.length) more.push(`Skipped ${ts.length - go.length} ${verb === 'launch' ? 'not in Backlog' : 'with nothing to resume'}.`);
  await act(() => sayLaunched(ok, more));
}
const toggleRunner = () => act(async () => {
  runner = await api('PUT', '/runner', { on: !runner.on });
  drawBoard();
});
/** While on: what it waits on against the limit, what is left, and who waits on shared files. Off by itself: why. Off by Stop: nothing. */
const runnerLine = (r) => r.on
  ? `Running: ${r.running.map((id) => `#${id}`).join(', ') || 'nothing yet'} (${r.running.length} of ${r.concurrency}; ${r.left} of ${r.backlog} candidates left)${r.waits.map((w) => `; #${w.id} waits: shares files with #${w.on}`).join('')}`
  : r.why ? `Runner stopped: ${r.why}` : '';
// Replaces a running ticket's agent, live or hung, with a fresh one in the same phase and worktree (docs/LIFECYCLE.md).
const restartable = (t) => t?.status === 'in_progress' || t?.status === 'testing';
async function restart(id) {
  if (!restartable(tickets.get(id))) return say(`#${id} is not In progress or Testing; nothing to restart.`);
  if ((await dialog('Restart ticket', `End the running agent for #${id} and start a new one in the same phase?`, ['Restart', 'Cancel'])) !== 'Restart') return;
  await act(async () => {
    await api('POST', `/tickets/${id}/restart`);
    await sayLaunched([id]);
  });
}
// Sends a Done ticket, merged or not, back to a worker with the operator's reason as its failure note (docs/LIFECYCLE.md → Reject).
async function reject(id) {
  const reason = h('textarea', { rows: 6, cols: 60 });
  const asked = dialog(`Reject #${id}`, h('div', { class: 'field-row-stacked' }, h('label', {}, 'What is wrong and what done looks like'), reason), ['Reject', 'Cancel']);
  const ok = reason.closest('dialog').querySelector('.k95-buttons button');
  ok.disabled = true; // an empty reason would tell the worker nothing; the daemon refuses it too
  reason.addEventListener('input', () => { ok.disabled = !reason.value.trim(); });
  if ((await asked) !== 'Reject') return;
  await act(async () => {
    await api('POST', `/tickets/${id}/reject`, { reason: reason.value });
    await sayLaunched([id]);
  });
}
/** `mission`: the operator's draft for the planner to start from (Notepad's selection). */
const newBrainstorm = (mission) => act(async () => openTerminal(await api('POST', '/brainstorm', typeof mission === 'string' ? { mission } : undefined)), 'Brainstorm started.');
/** An operator terminal: an agent with the operator's reach on the board, given the mission typed here. The daemon refuses an empty one. */
async function newOperator() {
  const mission = h('textarea', { rows: 8, cols: 60, placeholder: 'What should the agent do?' });
  const body = h('div', { class: 'field-row-stacked' }, h('label', {}, 'Mission'), mission);
  if ((await dialog('New operator terminal', body, ['Start', 'Cancel'])) !== 'Start') return;
  await act(async () => openTerminal(await api('POST', '/operator', { mission: mission.value })), 'Operator terminal started.');
}
/** Start → Restart board: the daemon rebuilds, exits 75, and the shell starts it again (docs/OPERATOR.md → Restart board). */
const STALE = 'Restart the board to use the merged changes.'; // runner.stale: a merge changed daemon/, shell/ or package.json since start
async function restartBoard() {
  const agents = sessions.filter((s) => s.ticket_id !== null).length;
  const terminals = sessions.length - agents;
  const body = h('div', {},
    h('p', {}, agents ? `${agents} agent${agents === 1 ? ' is' : 's are'} running; they are resumed after the restart.` : 'No agents are running.'),
    terminals > 0 && h('p', {}, `${terminals} brainstorm or operator terminal${terminals === 1 ? '' : 's'} will close.`),
    h('p', {}, 'The daemon is rebuilt and the UI reloads. Shell changes need a full relaunch (close Kanban95 and start it again).'),
    runner.stale === 'shell' && h('p', { class: 'k95-shell-stale' }, 'A merge changed the shell itself: after this restart, close Kanban95 and start it again to pick up its change.'));
  if ((await dialog('Restart board', body, ['Restart', 'Cancel'])) !== 'Restart') return;
  say('Building…');
  try {
    restarting = true;
    const r = await api('POST', '/restart');
    if (!r.shell) {
      restarting = false;
      say('The daemon stopped. No shell is running it: start it again by hand.');
    } else say('Restarting…');
  } catch (e) {
    restarting = false;
    say(`Board not restarted: ${e.status === 409 ? 'see the dialog' : e.message}`);
    // 409: the compiler output (the board keeps running the code it has), or a restart already under way.
    if (e.status === 409) await dialog('Board not restarted', h('pre', { class: 'k95-pre' }, e.message));
  }
}
const pushBase = () => act(async () => {
  say('Pushing…');
  runner = await api('POST', '/push');
  drawBoard();
}, 'Pushed.');
const housekeeping = () => act(async () => {
  const t = await api('POST', '/tickets/housekeeping');
  say(`Housekeeping ticket #${t.id} created and launched.`);
});

/** The card menu for the selected tickets, one or many. A ✓ marks a value every one of them has. */
function cardMenu(ts, x, y) {
  const same = (k) => (new Set(ts.map((t) => t[k] ?? null)).size === 1 ? ts[0][k] ?? null : undefined);
  const tick = (k, v) => (same(k) === v ? ' ✓' : '');
  const set = (k, v) => each(ts, (t) => api('PATCH', `/tickets/${t.id}`, { [k]: v }),
    (n) => `${k === 'cli' ? 'CLI' : k[0].toUpperCase() + k.slice(1)} set to ${v ?? 'the default'} on ${n}.`);
  const clis = new Set(ts.map((t) => t.cli ?? models?.cli));
  const known = [...new Set([...clis].flatMap((c) => PHASES.map((p) => models?.[c]?.[p]?.model)).filter(Boolean))];
  const resettable = ts.filter((t) => t.status !== 'backlog' || t.flags.blocked_on_deps);
  const waiting = ts.filter((t) => t.status === 'backlog' && t.flags.blocked_on_deps);
  const unmerged = ts.filter((t) => t.status === 'done' && !t.merged_at);
  menu(x, y, [
    { label: 'Open', run: () => {
      ts.slice(0, 8).forEach((t) => openTicket(t.id));
      if (ts.length > 8) say(`Opened 8 of ${ts.length} tickets; at most 8 open at once.`);
    } },
    // A live session's terminal, also one that did not open on its own (Settings → General).
    ...(ts.length === 1 && live(ts[0].id).length ? [{ label: 'Terminal', items: live(ts[0].id).map((s) => ({ label: `${s.phase} · ${s.model}`, run: () => openTerminal(s) })) }] : []),
    { label: 'Launch', disabled: !ts.some(launchable), run: () => launch(ts) },
    { label: 'Resume', disabled: !ts.some(resumable), run: () => launch(ts, 'resume') },
    ...(ts.length === 1 && restartable(ts[0]) ? [{ label: 'Restart', run: () => restart(ts[0].id) }] : []),
    ...(ts.length === 1 && ts[0].status === 'done' ? [{ label: 'Reject', run: () => reject(ts[0].id) }] : []),
    '-',
    { label: 'Model', items: [
      { label: `Phase default${tick('model', null)}`, run: () => set('model', null) },
      ...known.map((m) => ({ label: `${m}${tick('model', m)}`, run: () => set('model', m) })),
      { label: 'Other…', run: async () => {
        const input = h('input', { type: 'text', 'data-mic': 'off', value: same('model') ?? '', size: 32 });
        if ((await dialog(`Model for ${count(ts)}`, h('div', { class: 'field-row-stacked' }, h('label', {}, 'Model id'), input), ['OK', 'Cancel'])) === 'OK') {
          set('model', input.value.trim() || null);
        }
      } },
    ] },
    { label: 'Effort', items: [
      { label: `Phase default${tick('effort', null)}`, run: () => set('effort', null) },
      ...EFFORTS.map((e) => ({ label: `${e}${tick('effort', e)}`, run: () => set('effort', e) })),
    ] },
    { label: 'CLI', items: [
      { label: `Default${tick('cli', null)}`, run: () => set('cli', null) },
      ...CLIS.map((c) => ({ label: `${c}${tick('cli', c)}`, run: () => set('cli', c) })),
    ] },
    '-',
    { label: 'Retry merge', disabled: !unmerged.length, run: () => each(unmerged, (t) => api('POST', `/tickets/${t.id}/merge`), (n) => `Merge of ${n} queued.`) },
    { label: 'Cancel wait', disabled: !waiting.length, run: () => cancelWait(waiting) },
    { label: 'Reset to Backlog', disabled: !resettable.length, run: () => reset(resettable) },
    { label: 'Delete', run: async () => {
      const ask = ts.length === 1 ? `Delete #${ts[0].id} ${ts[0].title}? Its notes and runs go with it.`
        : `Delete ${count(ts)} (${ts.map((t) => `#${t.id}`).join(', ')})? Their notes and runs go with them.`;
      if ((await dialog(ts.length === 1 ? 'Delete ticket' : 'Delete tickets', ask, ['Delete', 'Cancel'])) === 'Delete') {
        each(ts, (t) => api('DELETE', `/tickets/${t.id}`), (n) => `${n} deleted.`);
      }
    } },
  ]);
}

// Folded columns, by status, in ui.json as `k95.collapsed`; `boot` fills the set once state.js has loaded.
const collapsed = new Set();
const saveCollapsed = () => ui.set('k95.collapsed', [...collapsed]);

// The Board's filter, sort and group, in ui.json as `k95.view` like the folded columns; `boot` fills it.
const view = { filter: '', sort: 'id', group: 'none' };
const saveView = () => ui.set('k95.view', { ...view });
const order = new Map(); // status → card ids as drawn, for a Shift+click range
const SORTS = { id: 'id', updated: 'updated', effort: 'effort', model: 'model', tags: 'tags', human: 'needs-human first' };
const RANK = { max: 0, high: 1, medium: 2, low: 3 };
/** What a card shows for each field the filter reads: the override, else the phase default its badge shows. */
const fields = (t) => {
  const d = defaults(t);
  return { id: `#${t.id}`, title: t.title, tag: t.tags ? t.tags.split(' ') : [], model: t.model ?? d.model ?? '', cli: t.cli ?? models?.cli ?? '', effort: t.effort ?? d.effort ?? 'medium' };
};
/** Every word must match some field; `tag:x` needs a tag equal to x, `model:`/`cli:`/`effort:` a substring of that field. */
function shown(t) {
  const words = view.filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const f = fields(t);
  const all = [f.id, f.title, ...f.tag, f.model, f.cli, f.effort].map((x) => x.toLowerCase());
  return words.every((w) => {
    const [, k, v] = /^(tag|model|effort|cli):(.*)$/.exec(w) ?? [];
    if (!k) return all.some((x) => x.includes(w));
    return k === 'tag' ? f.tag.some((g) => g.toLowerCase() === v) : f[k].toLowerCase().includes(v);
  });
}
const byKey = {
  updated: (a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''),
  effort: (a, b) => (RANK[a.effort] ?? RANK.medium) - (RANK[b.effort] ?? RANK.medium), // an unset effort ranks as medium, whatever the phase default
  model: (a, b) => fields(a).model.localeCompare(fields(b).model),
  tags: (a, b) => !a.tags - !b.tags || (a.tags ?? '').localeCompare(b.tags ?? ''), // untagged last
  human: (a, b) => !b.flags.needs_human - !a.flags.needs_human,
};
const sorted = (list) => list.sort((a, b) => (byKey[view.sort]?.(a, b) || 0) || a.id - b.id);
/** A column's cards, or with Group by tag one heading per tag (a card under each of its tags) and the untagged last. */
function columnBody(list) {
  if (view.group !== 'tag') return list.map(card);
  const groups = [...new Set(list.flatMap((t) => (t.tags ? t.tags.split(' ') : [])))].sort();
  const untagged = list.filter((t) => !t.tags);
  return [
    ...groups.flatMap((g) => [h('div', { class: 'k95-group' }, g), ...list.filter((t) => t.tags?.split(' ').includes(g)).map(card)]),
    ...(untagged.length && groups.length ? [h('div', { class: 'k95-group' }, 'untagged')] : []), ...untagged.map(card),
  ];
}

function openBoard() {
  const w = open('board', { title: 'Board', w: 1000, h: 560, persist: true, icon: 'board', onClose: () => { views.delete('board'); say = console.log; } });
  if (w.body.firstChild) return;
  const status = h('p', { class: 'status-bar-field', role: 'status' }, 'Ready');
  const count = h('p', { class: 'status-bar-field k95-count' });
  const run = h('button', { onclick: toggleRunner, title: 'Ctrl+L' });
  const runField = h('p', { class: 'status-bar-field k95-runner' });
  const viewField = h('p', { class: 'status-bar-field k95-view' });
  const filter = h('input', { type: 'text', class: 'k95-filter', 'data-mic': 'off', placeholder: 'Filter', value: view.filter,
    title: 'Ctrl+F. Every word must match the id, title, a tag, the model, CLI or effort; tag: model: cli: effort: narrow a word to that field.',
    oninput: () => {
      view.filter = filter.value;
      saveView();
      for (const id of selection) if (!tickets.has(id) || !shown(tickets.get(id))) selection.delete(id);
      drawBoard();
    },
    onkeydown: (e) => { // Esc clears the box instead of closing the Board
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      filter.value = '';
      filter.dispatchEvent(new Event('input'));
    } });
  const choose = (k, opts) => h('select', { class: `k95-${k}`, onchange: (e) => { view[k] = e.target.value; saveView(); drawBoard(); } },
    Object.entries(opts).map(([v, label]) => h('option', { value: v, selected: view[k] === v }, label)));
  const heldField = h('p', { class: 'status-bar-field k95-held' });
  // runner.unpushed: commits on the base its upstream lacks, counted on start; Push runs the merge queue's push.
  const unpushedText = h('span');
  const unpushedField = h('p', { class: 'status-bar-field k95-unpushed' }, unpushedText, ' ', h('button', { onclick: pushBase }, 'Push'));
  const cols = h('div', { class: 'k95-columns', onclick: (e) => { // a click on empty column space clears the selection
    if (!e.target.closest('.card')) selection.clear(), drawBoard();
  } });
  w.body.classList.add('k95-board');
  w.body.append(
    h('div', { class: 'k95-toolbar' },
      h('button', { onclick: () => launch(picked()) }, 'Launch'),
      run,
      h('button', { onclick: newBrainstorm, title: 'Ctrl+N' }, 'New brainstorm'),
      h('button', { onclick: () => openTicket(null) }, 'New ticket'),
      h('button', { onclick: housekeeping }, 'Housekeeping'),
      h('button', { onclick: cancelWaiting, title: 'Stop held tickets from launching when their dependencies merge' }, 'Cancel waiting'),
      filter,
      h('label', {}, 'Sort ', choose('sort', SORTS)),
      h('label', {}, 'Group ', choose('group', { none: 'none', tag: 'tag' }))),
    cols,
    h('div', { class: 'status-bar' }, status, runField, unpushedField, heldField, viewField, count));
  say = (msg) => { status.textContent = msg; status.title = msg; };
  views.set('board', () => {
    const all = [...tickets.values()];
    // A rebuild resets each column's scroll and drops focus; carry both across by status and card id.
    const scroll = Object.fromEntries([...cols.querySelectorAll('.col')].map((c) => [c.dataset.status, c.querySelector('.cards').scrollTop]));
    const focused = document.activeElement?.closest?.('.card');
    const focus = focused && cols.contains(focused) ? [focused.closest('.col').dataset.status, focused.dataset.id] : null;
    cols.replaceChildren(...COLUMNS.map(([s, label]) => {
      const list = all.filter((t) => t.status === s);
      const vis = sorted(list.filter(shown));
      order.set(s, vis.map((t) => t.id));
      const shut = collapsed.has(s);
      const legend = h('legend', { class: list.some((t) => t.flags.needs_human) ? 'alert' : '', title: shut ? 'Expand' : 'Collapse',
        onclick: (e) => { e.stopPropagation(); shut ? collapsed.delete(s) : collapsed.add(s); saveCollapsed(); drawBoard(); } },
      `${label} (${vis.length === list.length ? list.length : `${vis.length} of ${list.length}`})`);
      return h('fieldset', { class: `col${shut ? ' collapsed' : ''}`, 'data-status': s }, legend, h('div', { class: 'cards' }, shut ? [] : columnBody(vis)));
    }));
    cols.style.gridTemplateColumns = COLUMNS.map(([s]) => (collapsed.has(s) ? '24px' : 'minmax(0, 1fr)')).join(' ');
    for (const c of cols.querySelectorAll('.col')) c.querySelector('.cards').scrollTop = scroll[c.dataset.status] ?? 0;
    if (focus) cols.querySelector(`.col[data-status="${focus[0]}"] .card[data-id="${focus[1]}"]`)?.focus();
    count.textContent = `${all.length} tickets · ${sessions.length} agents`;
    run.textContent = runner.on ? 'Stop' : 'Run';
    runField.textContent = runField.title = runner.gitError ?? (runner.stale ? STALE : runnerLine(runner)); // gitError: GET /api/runner, set at start
    runField.hidden = !runField.textContent;
    viewField.textContent = viewField.title = [view.filter.trim() && `Filter: ${view.filter.trim()}`, view.sort !== 'id' && `Sort: ${SORTS[view.sort]}`,
      view.group !== 'none' && `Group: ${view.group}`].filter(Boolean).join(' · ');
    viewField.hidden = !viewField.textContent;
    const held = heldTickets().length;
    heldField.textContent = held ? `${held} waiting to launch by themselves` : '';
    heldField.hidden = !held;
    unpushedText.textContent = `${runner.unpushed} commit${runner.unpushed === 1 ? '' : 's'} not pushed`;
    unpushedField.hidden = !runner.unpushed;
  });
  drawBoard();
}
const drawBoard = () => views.get('board')?.(null);

// ---- ticket ----

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const table = (cols, rows) => h('div', { class: 'sunken-panel' }, h('table', { class: 'interactive' },
  h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, rows)));
const liveGrant = (g) => !g.revoked_at && g.expires_at > new Date().toISOString();

/** 98.css tabs. `draw(name, panel, first)`: first is true when the tab is shown, false when an event asks for a refresh. */
function tabs(names, draw, current = names[0]) {
  const bar = h('menu', { role: 'tablist' });
  const panel = h('div', { class: 'window k95-panel', role: 'tabpanel' });
  const show = (n) => {
    current = n;
    bar.replaceChildren(...names.map((x) => h('li', { role: 'tab', 'aria-selected': x === n ? 'true' : 'false' },
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); show(x); } }, x))));
    // A fresh body per switch: a draw still awaiting the daemon for the tab left behind fills a detached node, not this one.
    const body = h('div', { class: 'window-body' });
    panel.replaceChildren(body);
    draw(n, body, true);
  };
  show(current);
  return { el: [bar, panel], show: (n = current) => show(n), redraw: () => draw(current, panel.firstChild, false) };
}

/** Run a rebuild of `p` without losing the scroll of `p` or the run table inside it. */
function keepScroll(p, rebuild) {
  const top = p.scrollTop, inner = p.querySelector('.sunken-panel')?.scrollTop ?? 0;
  rebuild();
  p.scrollTop = top;
  const sp = p.querySelector('.sunken-panel');
  if (sp) sp.scrollTop = inner;
}

function openTicket(id) {
  const wid = `ticket-${id ?? 'new'}`;
  const w = open(wid, { title: id ? `Ticket #${id}` : 'New ticket', w: 680, h: 480, icon: 'ticket', onClose: () => views.delete(wid) });
  if (id === null) {
    if (!w.body.firstChild) w.body.append(ticketForm(w, null));
    return;
  }
  if (w.body.firstChild) return;
  const tb = tabs(['Ticket', 'Notes', 'Runs', 'Diff', 'Grants', 'Audit'], async (tab, p, first) => {
    const t = tickets.get(id);
    if (!t) return p.replaceChildren(h('p', {}, 'This ticket was deleted.'));
    w.title(`Ticket #${id} — ${t.title}`);
    if (tab === 'Ticket') {
      // The form is built when the tab is shown, so an event never overwrites what the operator is typing.
      if (first) p.replaceChildren(ticketForm(w, t), h('fieldset', { class: 'k95-attachments' }));
      else p.querySelector('.k95-facts')?.replaceWith(facts(t));
      const list = await attachmentList(id);
      p.querySelector('.k95-attachments')?.replaceWith(list);
    } else if (tab === 'Notes') {
      const notes = await api('GET', `/tickets/${id}/notes`);
      keepScroll(p, () => p.replaceChildren(notes.length ? h('ol', { class: 'k95-notes' }, notes.map((n) => h('li', { class: `note ${n.kind}` },
        h('div', { class: 'note-head' }, `${fmt(n.created_at)} · ${n.role} · ${n.kind}`), h('pre', {}, n.body)))) : h('p', {}, 'No notes yet.')));
    } else if (tab === 'Runs') {
      const runs = await api('GET', `/tickets/${id}/runs`);
      const view = h('pre', { class: 'k95-pre' }, 'Select a run to see the exact prompt it was given.');
      keepScroll(p, () => p.replaceChildren(table(['Run', 'Phase', 'CLI', 'Model', 'Effort', 'Started', 'Ended', 'Outcome', ''], runs.map((r) => {
        const s = sessions.find((x) => x.run_id === r.id);
        return h('tr', { onclick: () => { view.textContent = r.prompt_rendered; } },
          h('td', {}, r.id), h('td', {}, r.phase), h('td', {}, r.cli), h('td', {}, r.model), h('td', {}, r.effort),
          h('td', {}, fmt(r.started_at)), h('td', {}, fmt(r.ended_at)), h('td', {}, r.outcome ?? (s ? 'running' : '')),
          h('td', {}, s ? h('button', { onclick: () => openTerminal(s) }, 'Terminal')
            : r.scrollback ? h('button', { onclick: (e) => { e.stopPropagation(); view.textContent = r.scrollback; } }, 'Output') : ''));
      })), view));
    } else if (tab === 'Diff') {
      const { diff } = await api('GET', `/tickets/${id}/diff`);
      p.replaceChildren(h('pre', { class: 'k95-pre k95-diff' }, diff === null ? '(no worktree: not launched yet, or merged and cleaned up)' : diff || '(no changes yet)'));
    } else if (tab === 'Grants') {
      const grants = (await api('GET', '/grants')).filter((g) => g.ticket_id === id && liveGrant(g));
      p.replaceChildren(grants.length ? grantTable(grants) : h('p', {}, 'No live grants for this ticket.'));
    } else if (tab === 'Audit') {
      const rows = await api('GET', `/tickets/${id}/audit`);
      p.replaceChildren(table(['When', 'Grant', 'Tool', 'Outcome', 'Arguments'], rows.map((a) => h('tr', {},
        h('td', {}, fmt(a.created_at)), h('td', {}, a.grant_id ?? 'operator'), h('td', {}, a.tool), h('td', {}, a.outcome), h('td', { class: 'k95-args' }, a.args_summary)))));
    }
  });
  w.body.append(...tb.el);
  views.set(wid, (tid) => tid === id && tb.redraw());
  w.el.addEventListener('dragover', (e) => e.dataTransfer.types.includes('Files') && e.preventDefault());
  w.el.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    attach(id, [...e.dataTransfer.files]);
  });
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i; // the types the daemon serves inline
const attachmentUrl = (id, name) => `/api/tickets/${id}/attachments/${encodeURIComponent(name)}`;

/** Uploads to ticket `id`, one file at a time; the daemon's change event redraws the list. */
async function attach(id, files) {
  for (const f of files) {
    const r = await fetch(`/api/tickets/${id}/attachments?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
    if (!r.ok) return dialog('Not attached', `${f.name}: ${(await r.json()).error}`);
    say(`#${id}: attached ${(await r.json()).name}.`);
  }
}

/** The Ticket tab's attachments: a thumbnail for each image, Open and Remove. */
async function attachmentList(id) {
  const files = await api('GET', `/tickets/${id}/attachments`);
  return h('fieldset', { class: 'k95-attachments' }, h('legend', {}, 'Attachments'),
    files.length ? files.map((f) => {
      const url = attachmentUrl(id, f.name);
      const img = IMAGE.test(f.name);
      return h('div', { class: 'k95-attachment' }, img && h('img', { src: url, alt: '' }), h('span', {}, f.name),
        // An image opens in a board window; anything else downloads (the board's window can never navigate away).
        img ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); openImage(id, f.name); } }, 'Open') : h('a', { href: url, download: f.name }, 'Open'),
        h('button', { onclick: () => act(() => api('DELETE', `/tickets/${id}/attachments/${encodeURIComponent(f.name)}`), `#${id}: removed ${f.name}.`) }, 'Remove'));
    }) : h('p', {}, 'Paste a screenshot (Ctrl+V) or drop a file on this window to attach it.'));
}

function openImage(id, name) {
  const w = open(`attachment-${id}-${name}`, { title: name, w: 640, h: 480 });
  if (!w.body.firstChild) w.body.append(h('img', { src: attachmentUrl(id, name), alt: name, class: 'k95-image' }));
}

function facts(t) {
  return h('p', { class: 'k95-facts' }, LABEL[t.status], t.flags.needs_human && ' · needs human (the Inbox says why)', t.flags.blocked_on_deps && ' · waiting on dependencies',
    ` · retry ${t.retry}`, t.template === 'housekeeping' && ' · housekeeping', t.merged_at && ` · merged ${fmt(t.merged_at)}`);
}

/** The ticket's own fields: edits an existing ticket, or creates one (`t` null) and swaps the window for the new ticket's. */
function ticketForm(w, t) {
  const title = h('input', { type: 'text', value: t?.title ?? '' });
  const body = h('textarea', { rows: 6, 'data-field': 'body' }, t?.body ?? '');
  const criteria = h('textarea', { rows: 5 }, t?.criteria ?? '');
  const tags = h('input', { type: 'text', 'data-mic': 'off', value: t?.tags.split(' ').join(', ') ?? '', placeholder: 'e.g. ui, daemon' });
  const deps = h('input', { type: 'text', 'data-mic': 'off', value: t?.depends_on.join(', ') ?? '', placeholder: 'e.g. 3, 4' });
  const save = async () => {
    const fields = { title: title.value, body: body.value, criteria: criteria.value, tags: tags.value, depends_on: deps.value.split(/[\s,]+/).filter(Boolean).map(Number) };
    try {
      if (t) {
        await api('PATCH', `/tickets/${t.id}`, fields);
        say(`#${t.id} saved.`);
      } else {
        const n = await api('POST', '/tickets', fields);
        w.close();
        openTicket(n.id);
        say(`#${n.id} created.`);
      }
    } catch (e) {
      dialog('Not saved', e.message);
    }
  };
  return h('div', { class: 'k95-form' }, t ? facts(t) : h('p', { class: 'k95-facts' }, 'A new ticket starts in Backlog.'),
    h('div', { class: 'field-row-stacked' }, h('label', {}, 'Title'), title),
    h('div', { class: 'field-row-stacked' }, h('label', {}, 'Body'), body),
    h('div', { class: 'field-row-stacked' }, h('label', {}, 'Acceptance criteria, one per line'), criteria),
    h('div', { class: 'field-row-stacked' }, h('label', {}, 'Tags, comma or space separated'), tags),
    h('div', { class: 'field-row-stacked' }, h('label', {}, 'Depends on'), deps),
    h('div', { class: 'field-row' }, h('button', { onclick: save }, t ? 'Save' : 'Create'),
      t && h('button', { disabled: t.status !== 'backlog', onclick: () => launch([t]) }, 'Launch'),
      t && h('button', { onclick: () => restart(t.id) }, 'Restart'),
      t?.status === 'done' && h('button', { onclick: () => reject(t.id) }, 'Reject')));
}

// ---- terminals ----

const seen = new Set();
const terms = new Map(); // open terminal window id → { s: its session, paint: recolour its title bar, fit: refit it to its window }
// A terminal's title-bar colour, first match wins; app.css → `.k95-win[data-state]` holds the palette. A new state is a line
// here and a rule there.
function termState(s, ended) {
  if (ended) return 'ended';
  if (tickets.get(s.ticket_id)?.flags.needs_human) return 'human';
  if (s.ticket_id === null) return 'plan'; // brainstorm (planner) or operator terminal
  if (s.phase === 'execute' || s.phase === 'test') return s.phase;
  return null;
}
/** A terminal's taskbar icon: what kind of agent runs in it. */
function termIcon(s) {
  if (s.ticket_id === null) return s.role === 'operator' ? 'operator' : 'brainstorm';
  return { plan: 'brainstorm', execute: 'execute', test: 'test' }[s.phase] ?? 'window';
}
/**
 * Opens a terminal for each new session of a phase in Settings → General (`terminals.auto`); brainstorms and operator
 * terminals always. The rest are marked seen, so they never pop up later; card → Terminal opens one.
 */
function openNewTerminals() {
  if (!settings.terminals) return;
  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    if (s.ticket_id === null || settings.terminals.auto.includes(s.phase)) openTerminal(s, true);
    else seen.add(s.id);
  }
}

/**
 * A run's terminal. The board opens one for every new session on its own (`auto`): behind the focused window, and closed
 * again shortly after its agent reports (submit, pass, fail). One that was revoked or died stays open, marked ended.
 */
function openTerminal(s, auto = false) {
  seen.add(s.id);
  const wid = `term-${s.id}`;
  if (isOpen(wid)) return focus(wid);
  const title = s.ticket_id === null ? `${s.role === 'operator' ? 'Operator' : 'Brainstorm'} — ${s.model || 'CLI default'}` : `#${s.ticket_id} — ${s.phase} — ${s.model}`;
  const ws = new WebSocket(`ws://${location.host}/pty/${s.id}`);
  const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  const term = new Terminal({ fontFamily: 'Consolas, "Courier New", monospace', fontSize: 13, scrollback: 5000 });
  const fit = new FitAddon();
  const ro = new ResizeObserver(() => fit.fit());
  // Spoken words are typed into the agent's terminal without Enter; the operator presses it.
  // X ends the agent for good, after a confirm; the board's own closes (after a report, a deleted ticket) never do.
  const onX = async () => {
    if (w.el.classList.contains('ended')) return w.close();
    const ask = s.ticket_id === null ? `End this ${s.role === 'operator' ? 'operator terminal' : 'brainstorm'}?` : `End the agent for #${s.ticket_id}? The ticket is flagged so you can resume it.`;
    if ((await dialog('End agent', `${ask} Minimize to keep it running.`, ['End', 'Cancel'])) !== 'End') return;
    try {
      await api('DELETE', `/sessions/${s.id}`);
      w.close();
    } catch (e) {
      say(e.message);
    }
  };
  const w = open(wid, { title, w: 760, h: 440, tile: true, background: auto, onX, extra: [micButton((text) => send({ data: text }))],
    icon: termIcon(s),
    items: s.ticket_id === null ? [] : [{ label: 'Open ticket', run: () => openTicket(s.ticket_id) }], onClose: () => { terms.delete(wid); ro.disconnect(); ws.close(); term.dispose(); } });
  let was = null;
  const paint = () => {
    const state = termState(s, w.el.classList.contains('ended'));
    if (state === 'human' && was !== 'human') raise(wid); // needs you: in front, without taking the keyboard
    was = state;
    if (state) w.el.dataset.state = state;
    else delete w.el.dataset.state; // an unknown phase keeps the 98.css look
  };
  terms.set(wid, { s, paint, fit: () => fit.fit() });
  paint();
  w.body.classList.add('k95-term');
  term.loadAddon(fit);
  term.open(w.body);
  ws.onmessage = (m) => term.write(m.data);
  ws.onopen = () => { fit.fit(); send({ resize: [term.cols, term.rows] }); };
  ws.onclose = () => {
    term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
    w.title(`${title} (ended)`);
    w.el.classList.add('ended');
    paint();
    if (!auto || s.run_id === null) return;
    // The run's outcome is written as its terminal closes; its output stays in Ticket → Runs. Every outcome the board itself
    // ends a run with closes it: after conflict and restart a new run is already open, and a stale "ended" window in front of
    // it reads as a stuck ticket.
    setTimeout(async () => {
      const run = (await api('GET', `/tickets/${s.ticket_id}/runs`).catch(() => [])).find((r) => r.id === s.run_id);
      if (['submit', 'pass', 'fail', 'conflict', 'restart'].includes(run?.outcome)) setTimeout(w.close, 1500);
    }, 500);
  };
  // The zoom keys belong to the agent here. xterm sends nothing for them and lets them through to the webview's own zoom:
  // Ctrl+- goes as 0x1f, as a native terminal sends it (Ctrl+_), and Ctrl+= and Ctrl+0, which have no byte, are swallowed.
  term.attachCustomKeyEventHandler((e) => {
    if (!e.ctrlKey || e.altKey || !['-', '=', '+', '0'].includes(e.key)) return true;
    e.preventDefault();
    if (e.type === 'keydown' && e.key === '-') send({ data: '\x1f' });
    return false;
  });
  term.onData((d) => send({ data: d }));
  term.onResize(({ cols, rows }) => send({ resize: [cols, rows] }));
  ro.observe(w.body);
}

// ---- brain ----

// Two brains (docs/AGENTS.md → The brain): the project's own and the global one every board shares. A row is scope + id.
const SCOPES = ['project', 'global'];
const scopePick = (value, label = (s) => s) => h('select', {}, SCOPES.map((s) => h('option', { value: s, selected: s === value }, label(s))));
const brainPath = (b) => `/brain/${b.id}?scope=${b.scope}`;

function openBrain() {
  const w = open('brain', { title: 'Brain', w: 560, h: 460, persist: true, icon: 'brain' });
  if (w.body.firstChild) return;
  const q = h('input', { type: 'search', placeholder: 'Search notes' });
  const only = h('select', { class: 'k95-brain-scope', title: 'Which brain', onchange: () => search() },
    h('option', { value: '' }, 'All'), h('option', { value: 'project' }, 'Project'), h('option', { value: 'global' }, 'Global'));
  const results = h('ol', { class: 'k95-notes' });
  const search = async () => {
    const rows = await api('GET', `/brain?q=${encodeURIComponent(q.value)}&scope=${only.value}`);
    results.replaceChildren(...(rows.length ? rows.map((b) => h('li', { class: 'note', 'data-scope': b.scope },
      h('div', { class: 'note-head' }, `#${b.id} ${b.title}`, b.tags && ` · ${b.tags}`),
      // Provenance: a row from a ticket that never landed may describe code that does not exist.
      h('div', { class: 'note-meta' }, h('span', { class: 'scope' }, b.scope), ` · ${fmt(b.created_at)}`, b.ticket_id && ` · ticket #${b.ticket_id} (${b.ticket_status ?? 'deleted'})`,
        h('button', { onclick: () => edit(b) }, 'Edit'), h('button', { onclick: () => remove(b) }, 'Delete')),
      h('pre', {}, b.body))) : [h('li', {}, 'Nothing found.')]));
  };
  // Merge = edit the survivor, delete the rest. Choosing the other scope moves the row there under a new id.
  const edit = async (b) => {
    const f = { title: h('input', { type: 'text', value: b.title }), tags: h('input', { type: 'text', 'data-mic': 'off', value: b.tags }), body: h('textarea', { rows: 10 }, b.body), scope: scopePick(b.scope) };
    const form = h('div', { class: 'k95-brain-edit' }, ...Object.entries(f).map(([k, el]) => h('div', { class: 'field-row-stacked' }, h('label', {}, k), el)));
    if ((await dialog(`Edit ${b.scope} brain #${b.id}`, form, ['Save', 'Cancel'])) !== 'Save') return;
    const move = f.scope.value !== b.scope;
    act(async () => {
      await api('PATCH', brainPath(b), { title: f.title.value, body: f.body.value, tags: f.tags.value, ...(move && { move_to: f.scope.value }) });
      await search();
    }, move ? `Brain #${b.id} moved to the ${f.scope.value} brain.` : `Brain #${b.id} saved.`);
  };
  const remove = async (b) => {
    if ((await dialog('Delete brain note', `Delete ${b.scope} #${b.id} "${b.title}"? No agent will see it again.`, ['Delete', 'Cancel'])) !== 'Delete') return;
    act(async () => {
      await api('DELETE', brainPath(b));
      await search();
    }, `Brain #${b.id} deleted.`);
  };
  const title = h('input', { type: 'text', placeholder: 'Title' });
  const tags = h('input', { type: 'text', 'data-mic': 'off', placeholder: 'tags' });
  const body = h('textarea', { rows: 3, placeholder: 'What the next agent should know' });
  const scope = scopePick('project', (s) => (s === 'project' ? 'Project: about this codebase' : 'Global: holds in any repo'));
  const add = () => act(async () => {
    await api('POST', '/brain', { title: title.value, body: body.value, tags: tags.value, scope: scope.value });
    title.value = body.value = tags.value = '';
    await search();
  }, 'Note added to the brain.');
  q.addEventListener('keydown', (e) => e.key === 'Enter' && search());
  w.body.classList.add('k95-brain');
  w.body.append(h('div', { class: 'field-row' }, q, only, h('button', { onclick: search }, 'Search')), results,
    h('fieldset', {}, h('legend', {}, 'Add note'), h('div', { class: 'field-row' }, title, tags), h('div', { class: 'field-row' }, body), h('div', { class: 'field-row' }, scope, h('button', { onclick: add }, 'Add'))));
  search();
}

// ---- inbox ----

function openInbox() {
  const w = open('inbox', { title: 'Inbox', w: 560, h: 400, persist: true, icon: 'inbox', onClose: () => views.delete('inbox') });
  if (w.body.firstChild) return;
  let shown = null;
  const draw = () => {
    const ids = inbox.map((q) => q.id).join();
    if (ids === shown) return; // unchanged: keep whatever the operator is typing
    shown = ids;
    w.body.replaceChildren(...(inbox.length ? inbox.map((q) => {
      const legend = h('legend', {}, `#${q.ticket_id} ${q.title}`);
      if (q.kind === 'failure') {
        // The note ends with "To resolve: …" (docs/LIFECYCLE.md → Needs human); the buttons are the actions it names.
        const t = tickets.get(q.ticket_id);
        return h('fieldset', { class: 'k95-flag', 'data-ticket': q.ticket_id }, legend,
          h('div', { class: 'note-head' }, `${fmt(q.created_at)} · ${q.role} · stopped:`), h('pre', {}, q.body),
          h('div', { class: 'field-row' },
            h('button', { onclick: () => openTicket(q.ticket_id) }, 'Open ticket'),
            q.status === 'done' && !q.merged_at && h('button', { onclick: () => act(() => api('POST', `/tickets/${q.ticket_id}/merge`), `Merge of #${q.ticket_id} queued.`) }, 'Retry merge'),
            (q.status === 'in_progress' || q.status === 'testing') && t && h('button', { onclick: () => launch([t], 'resume') }, 'Resume'),
            (q.status === 'in_progress' || q.status === 'testing') && h('button', { onclick: () => restart(q.ticket_id) }, 'Restart'),
            q.status !== 'done' && t && h('button', { onclick: () => reset([t]) }, 'Reset to Backlog')));
      }
      const answer = h('textarea', { rows: 3, placeholder: 'Your answer' });
      return h('fieldset', { class: 'k95-question', 'data-ticket': q.ticket_id }, legend,
        h('div', { class: 'note-head' }, `${fmt(q.created_at)} · the ${q.role} asks:`), h('pre', {}, q.body),
        h('div', { class: 'field-row' }, answer),
        h('button', { onclick: () => act(() => api('POST', `/tickets/${q.ticket_id}/answer`, { answer: answer.value }), `Answer sent to #${q.ticket_id}.`) }, 'Answer'));
    }) : [h('p', {}, 'Nothing needs you.')]));
  };
  views.set('inbox', draw);
  draw();
}

// ---- settings ----

async function saveSettings(patch) {
  settings = (await api('PUT', '/config/settings', { ...settings, ...patch })).value;
  configure(settings.voice);
}

// UI zoom, 80% to 200% in 10% steps. The body's CSS zoom scales the terminals' text as well (xterm measures its cells after
// zoom), so their fontSize stays put and they only refit.
const ZOOMS = Array.from({ length: 13 }, (_, i) => (8 + i) / 10);
function applyZoom(f) {
  setZoom(f);
  for (const t of terms.values()) t.fit();
}
// One PUT at a time, so a fast run of key presses lands in order. Each sends the settings as they are now and does not take the
// answer back: an earlier answer would put back an older zoom while the operator is still pressing.
let zoomSaved = Promise.resolve();
function zoomTo(f) {
  if (f === settings.zoom) return;
  settings.zoom = f;
  applyZoom(f);
  const pick = document.getElementById('zoom'); // Settings → General, when open
  if (pick) pick.value = f;
  zoomSaved = zoomSaved.then(() => act(() => api('PUT', '/config/settings', settings), `Zoom ${Math.round(f * 100)}%.`));
}
// From the nearest step, so a hand-edited 1.25 still moves by one.
const zoomStep = (d) => {
  const i = ZOOMS.reduce((b, f, j) => (Math.abs(f - settings.zoom) < Math.abs(ZOOMS[b] - settings.zoom) ? j : b), 0);
  zoomTo(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + d))]);
};

function grantTable(grants) {
  return table(['Grant', 'Ticket', 'Role', 'Session', 'Expires', ''], grants.map((g) => {
    const s = sessions.find((x) => x.grant_id === g.id);
    return h('tr', {}, h('td', {}, g.id), h('td', {}, g.ticket_id ? `#${g.ticket_id}` : g.role === 'operator' ? 'operator terminal' : 'brainstorm'), h('td', {}, g.role),
      h('td', {}, s ? `${s.phase} · ${s.model}` : 'none'), h('td', {}, fmt(g.expires_at)),
      h('td', {}, h('button', { 'data-grant': g.id, onclick: () => act(() => api('DELETE', `/grants/${g.id}`), `Grant ${g.id} revoked; its session was stopped.`) }, 'Revoke')));
  }));
}

// ---- projects ----

// This board's project (GET /api/project): its folder name titles the window, its colour paints the wallpaper. A hue is
// painted at the teal's own saturation and lightness (#008080 is hue 180).
const cssColour = (c) => (typeof c === 'number' ? `hsl(${c} 100% 25%)` : c);
async function paintProject() {
  const p = await api('GET', '/project');
  document.body.style.setProperty('--k95-wall', cssColour(p.colour));
  document.title = `${p.name} — Kanban95`;
  return p;
}
/** `<input type="color">` takes only #rrggbb; a canvas spells any CSS colour that way. */
const hex = (c) => {
  const g = document.createElement('canvas').getContext('2d');
  g.fillStyle = cssColour(c);
  return g.fillStyle;
};

/** Settings → Projects: every repo with a board. Each change saves the whole list at once. */
async function projectsPanel(p) {
  const [own, { path, value }] = await Promise.all([api('GET', '/project'), api('GET', '/projects')]);
  let list = value;
  const save = (next, ok) => act(async () => {
    list = (await api('PUT', '/projects', { value: next })).value;
    await paintProject();
    draw();
  }, ok);
  const add = h('input', { type: 'text', id: 'project-add', placeholder: 'C:\\path\\to\\folder', style: 'flex: 1' });
  const draw = () => p.replaceChildren(h('p', {}, `${path}. A board's own project cannot be removed.`),
    table(['Project', 'Path', 'Colour', ''], list.map((x, i) => {
      const self = x.path === own.path; // both spelled by the daemon
      return h('tr', { 'data-project': x.path }, h('td', {}, x.path.split(/[\\/]/).pop() + (self ? ' (this board)' : '')), h('td', {}, x.path),
        h('td', {}, h('input', { type: 'color', value: hex(x.colour),
          onchange: (e) => save(list.map((y, j) => (j === i ? { ...y, colour: e.target.value } : y)), 'Colour saved.') })),
        h('td', {}, h('button', { disabled: self, onclick: () => save(list.filter((_, j) => j !== i), 'Project removed.') }, 'Remove')));
    })),
    h('div', { class: 'field-row' }, h('label', { for: 'project-add' }, 'Folder'), add,
      h('button', { onclick: () => save([...list, { path: add.value.trim(), colour: '#008080' }], 'Project added.') }, 'Add')));
  draw();
}

/**
 * Start → Projects: every project by folder name, running ones marked, this board's own disabled. Read at boot, whenever
 * this window gets focus (coming back from another board) and as Start opens, so the menu itself opens at once.
 * ponytail: a board started or closed while this window kept focus shows from the second Start opening; a registry event would fix it.
 */
let projectItems = [];
async function loadProjectItems() {
  try {
    const [own, { value, running }] = await Promise.all([api('GET', '/project'), api('GET', '/projects')]);
    projectItems = value.map((p) => {
      const name = p.path.split(/[\\/]/).pop();
      const self = p.path === own.path; // both spelled by the daemon
      return { label: name + (self ? ' (this board)' : running[p.path] ? ' (running)' : ''), disabled: self, run: () => switchProject(p.path, name, running[p.path]) };
    });
  } catch (e) {
    projectItems = [{ label: `Projects: ${e.message}`, disabled: true }];
  }
}
/** A running board's window comes to the front; any other project starts a new board (docs/OPERATOR.md → Start → Projects). */
async function switchProject(path, name, live) {
  say(live ? `Focusing ${name}…` : `Opening ${name}…`);
  try {
    const r = await api('POST', live ? '/projects/focus' : '/projects/open', { path });
    if (live) say(r.focused ? `Focused ${name}` : `${name} is running: switch to its window.`);
  } catch (e) {
    say(`${name} not ${live ? 'focused' : 'opened'}: ${e.message}`);
  }
}

let settingsTabs = null;
/** `tab`: the tab to show, also when the window is already open. */
function openSettings(tab) {
  const w = open('settings', { title: 'Settings', w: 640, h: 440, persist: true, icon: 'settings', onClose: () => views.delete('settings') });
  if (w.body.firstChild) return tab && settingsTabs.show(tab);
  const tb = settingsTabs = tabs(['Models', 'CLIs', 'Prompts', 'Grants', 'Limits', 'Voice', 'Projects', 'General'], async (tab, p, first) => {
    if (tab === 'Limits') return limitsPanel(p);
    if (tab === 'Grants') {
      const grants = (await api('GET', '/grants')).filter(liveGrant);
      return p.replaceChildren(h('p', {}, 'Every live agent grant. Revoke invalidates its token and stops its terminal.'), grants.length ? grantTable(grants) : h('p', {}, 'No live grants.'));
    }
    if (!first) return; // the other tabs are forms; events leave them alone
    if (tab === 'Models') {
      const [{ path, value }, known] = await Promise.all([api('GET', '/config/models'), api('GET', '/models')]);
      const m = value ?? { cli: 'claude' };
      const cli = h('select', {}, CLIS.map((c) => h('option', { selected: m.cli === c }, c)));
      const cells = {};
      const rows = PHASES.map((ph) => h('tr', {}, h('th', {}, ph), CLIS.flatMap((c) => {
        const model = h('input', { type: 'text', 'data-mic': 'off', size: 16, value: m[c]?.[ph]?.model ?? '' });
        const effort = h('select', {}, EFFORTS.map((e) => h('option', { selected: (m[c]?.[ph]?.effort ?? 'medium') === e }, e)));
        cells[`${c}.${ph}`] = { model, effort };
        // Free text, or ▾ for what the installed CLI offers now (plus the ids already saved for it).
        const pick = h('button', { class: 'k95-pick', title: `Models ${c} offers`, onclick: () => {
          const ids = [...new Set([...known[c], ...PHASES.map((q) => m[c]?.[q]?.model).filter(Boolean)])];
          const r = pick.getBoundingClientRect();
          menu(r.left, r.bottom, ids.length ? ids.map((id) => ({ label: id, run: () => { model.value = id; } }))
            : [{ label: `${c} lists no models: type the id`, disabled: true }]);
        } }, '▾');
        return [h('td', {}, model, pick), h('td', {}, effort)];
      })));
      const save = () => act(async () => {
        const out = { cli: cli.value };
        for (const c of CLIS) if (m[c]?.models) (out[c] ??= {}).models = m[c].models; // hand-edited; kept as is
        for (const c of CLIS) for (const ph of PHASES) {
          const { model, effort } = cells[`${c}.${ph}`];
          if (model.value.trim()) (out[c] ??= {})[ph] = { model: model.value.trim(), effort: effort.value };
        }
        models = (await api('PUT', '/config/models', out)).value;
        drawBoard();
      }, `Saved ${path}.`);
      p.replaceChildren(h('p', {}, `Which CLI runs agents, and the model and effort per phase (plan is the brainstorm; operator is the operator terminal, the CLI's default model when blank). A ticket's own model and effort override execute. ${path}`),
        h('div', { class: 'field-row' }, h('label', {}, 'Default CLI'), cli),
        h('table', { class: 'k95-models' }, h('thead', {}, h('tr', {}, h('th', {}), CLIS.flatMap((c) => [h('th', {}, `${c} model`), h('th', {}, 'effort')]))), h('tbody', {}, rows)),
        h('button', { onclick: save }, 'Save'));
    } else if (tab === 'CLIs') {
      const paths = Object.fromEntries(CLIS.map((c) => [c, h('input', { type: 'text', 'data-mic': 'off', size: 44, value: settings.paths[c] ?? '', placeholder: `${c} (found on PATH)` })]));
      const trust = await api('GET', '/trust');
      p.replaceChildren(
        h('fieldset', {}, h('legend', {}, 'Executables'), CLIS.map((c) => h('div', { class: 'field-row' }, h('label', { class: 'k95-label' }, c), paths[c])),
          h('button', { onclick: () => act(() => saveSettings({ paths: Object.fromEntries(CLIS.map((c) => [c, paths[c].value.trim()])) }), 'CLI paths saved.') }, 'Save')),
        h('fieldset', {}, h('legend', {}, 'Trusted folders'),
          h('p', {}, trust.trusted
            ? `Claude Code trusts ${trust.key}${trust.byBoard ? ' (written by the board)' : ''} in ${trust.file}. Its worktrees open without the trust prompt.`
            : `Claude Code does not trust ${trust.key}; the board writes that entry before the next Claude launch.`),
          h('p', {}, 'Codex is told per launch that this repo is trusted; nothing is written to its config.'),
          h('button', { disabled: !trust.trusted, onclick: () => act(async () => { await api('DELETE', '/trust'); tb.show(); }, 'Claude trust entry cleared.') }, 'Clear Claude trust')));
    } else if (tab === 'Prompts') {
      const [{ path, value }, tpls] = await Promise.all([api('GET', '/config/preferences'), api('GET', '/templates')]);
      const text = h('textarea', { id: 'preferences', rows: 10, placeholder: 'e.g. No em dashes or non-ASCII characters in output.' });
      text.value = value;
      // One template at a time: the select picks it, Save and Reset replace its entry with what the daemon wrote.
      const byName = Object.fromEntries(tpls.templates.map((t) => [t.name, t]));
      // A stale copy differs from the shipped default (edited, or from an older default the board would not overwrite): its option and Reset say so.
      const label = (t) => (t.stale ? `${t.name} (differs from default)` : t.name);
      const pick = h('select', { id: 'template' }, tpls.templates.map((t) => h('option', { value: t.name }, label(t))));
      const body = h('textarea', { id: 'template-text', rows: 14, spellcheck: 'false', 'data-mic': 'off' });
      const where = h('p', {});
      const stale = h('span', { id: 'template-stale' }, 'Differs from the shipped default.');
      const show = (t) => {
        byName[t.name] = t; body.value = t.text; where.textContent = t.path;
        stale.hidden = !t.stale;
        [...pick.options].find((o) => o.value === t.name).textContent = label(t);
      };
      pick.onchange = () => show(byName[pick.value]);
      show(tpls.templates[0]);
      p.replaceChildren(h('fieldset', {}, h('legend', {}, 'Preferences'),
        h('p', {}, `Standing instructions every agent prompt gets under "Operator preferences". Up to 16 KB. ${path}`),
        h('div', { class: 'field-row' }, text),
        h('button', { onclick: () => act(() => api('PUT', '/config/preferences', { value: text.value }), `Saved ${path}.`) }, 'Save')),
        h('fieldset', {}, h('legend', {}, 'Templates'),
          h('p', {}, 'The prompt each phase starts from; the next run uses what you save.'),
          h('div', { class: 'field-row' }, h('label', { for: 'template' }, 'Template'), pick),
          h('div', { class: 'field-row' }, body),
          h('p', { id: 'template-vars' }, `Variables: ${tpls.vars.map((v) => `{{${v}}}`).join(' ')}`),
          where,
          h('button', { onclick: () => act(async () => show(await api('PUT', `/templates/${pick.value}`, { text: body.value })), `Saved ${pick.value}.md.`) }, 'Save'),
          h('button', { onclick: () => act(async () => show(await api('POST', `/templates/${pick.value}/reset`)), `${pick.value}.md reset to default.`) }, 'Reset to default'),
          ' ', stale));
    } else if (tab === 'Voice') {
      const s = await api('GET', '/voice');
      const mode = (v, label) => h('div', { class: 'field-row' }, h('input', { type: 'radio', id: `mode-${v}`, name: 'mode', checked: settings.voice.mode === v,
        onchange: () => act(() => saveSettings({ voice: { ...settings.voice, mode: v } }), 'Voice mode saved.') }), h('label', { for: `mode-${v}` }, label));
      p.replaceChildren(
        h('fieldset', {}, h('legend', {}, 'Speech model'),
          h('p', {}, `${s.id}, ${(s.size / 1e6).toFixed(1)} MB: ${s.downloaded ? 'downloaded and verified' : 'not downloaded'}.`),
          !s.downloaded && h('button', { onclick: async () => { if (await ensureModel()) tb.show(); } }, 'Download…')),
        h('fieldset', {}, h('legend', {}, 'Backend'), h('select', { disabled: true }, h('option', {}, 'local')),
          h('p', {}, 'Local: transcription runs inside this window. Audio is never sent anywhere.')),
        h('fieldset', {}, h('legend', {}, 'Mic button'), mode('push', 'Push to talk (hold the button)'), mode('toggle', 'Toggle (click to start, click to stop)')));
    } else if (tab === 'Projects') {
      await projectsPanel(p);
    } else if (tab === 'General') {
      const at = h('input', { type: 'number', id: 'concurrency', min: 1, max: 10, step: 1, value: runner.concurrency });
      const saveRunner = () => act(async () => {
        runner = await api('PUT', '/runner', { concurrency: Number(at.value) });
        drawBoard();
      }, 'Saved.');
      const hkAuto = h('input', { type: 'checkbox', id: 'hk-auto', checked: settings.housekeeping.auto });
      const pushAuto = h('input', { type: 'checkbox', id: 'push-after-merge', checked: settings.push_after_merge,
        onchange: (e) => act(() => saveSettings({ push_after_merge: e.target.checked }), 'Saved.') });
      const hkEvery = h('input', { type: 'number', id: 'hk-every', min: 1, step: 1, value: settings.housekeeping.every });
      const idle = h('input', { type: 'number', id: 'idle-minutes', min: 1, step: 1, value: settings.idle_minutes });
      const zoom = h('select', { id: 'zoom', onchange: (e) => zoomTo(Number(e.target.value)) },
        ZOOMS.map((f) => h('option', { value: f, selected: f === settings.zoom }, `${Math.round(f * 100)}%`)));
      p.replaceChildren(h('div', { class: 'field-row' }, h('label', { for: 'zoom' }, 'Zoom (Ctrl+= / Ctrl+- / Ctrl+0)'), zoom),
        ...[['merge', 'Ding when a ticket merges'], ['attention', 'Chord when the board needs you']].map(([k, label]) =>
        h('div', { class: 'field-row' }, h('input', { type: 'checkbox', id: `sound-${k}`, checked: settings.sounds[k],
          onchange: (e) => act(() => saveSettings({ sounds: { ...settings.sounds, [k]: e.target.checked } }), 'Saved.') }), h('label', { for: `sound-${k}` }, label))),
        h('fieldset', {}, h('legend', {}, 'Open a terminal automatically for'),
          ...['plan', 'execute', 'test'].map((ph) => h('div', { class: 'field-row' }, h('input', { type: 'checkbox', id: `term-auto-${ph}`, checked: settings.terminals.auto.includes(ph),
            onchange: (e) => act(() => saveSettings({ terminals: { ...settings.terminals, auto: [...settings.terminals.auto.filter((x) => x !== ph), ...(e.target.checked ? [ph] : [])] } }), 'Saved.') }),
          h('label', { for: `term-auto-${ph}` }, ph))),
          h('p', {}, 'Brainstorms always open. A hidden session still runs: right-click its card → Terminal.')),
        h('div', { class: 'field-row' }, h('input', { type: 'checkbox', id: 'term-tile', checked: settings.terminals.tile,
          onchange: (e) => act(async () => { await saveSettings({ terminals: { ...settings.terminals, tile: e.target.checked } }); setTiling(settings.terminals.tile); }, 'Saved.') }),
        h('label', { for: 'term-tile' }, 'Tile terminals into slots left of the Board')),
        h('fieldset', {}, h('legend', {}, 'Runner'),
          h('div', { class: 'field-row' }, h('label', { for: 'concurrency' }, 'Tickets running at once'), at),
          h('button', { onclick: saveRunner }, 'Save')),
        h('fieldset', {}, h('legend', {}, 'Git'),
          h('div', { class: 'field-row' }, pushAuto, h('label', { for: 'push-after-merge' }, 'Push the base branch to its upstream after each merge'))),
        h('fieldset', {}, h('legend', {}, 'Silent agents'),
          h('div', { class: 'field-row' }, h('label', { for: 'idle-minutes' }, 'Flag an agent whose transcript is quiet for (minutes)'), idle),
          h('p', {}, 'Keep it above the 10 min tool timeout, so a long test run is not flagged.'),
          h('button', { onclick: () => act(() => saveSettings({ idle_minutes: Number(idle.value) }), 'Saved.') }, 'Save')),
        h('fieldset', {}, h('legend', {}, 'Housekeeping'),
          h('div', { class: 'field-row' }, hkAuto, h('label', { for: 'hk-auto' }, 'File a housekeeping ticket after merges')),
          h('div', { class: 'field-row' }, h('label', { for: 'hk-every' }, 'Merged tickets between runs'), hkEvery),
          h('button', { onclick: () => act(() => saveSettings({ housekeeping: { auto: hkAuto.checked, every: Number(hkEvery.value) } }), 'Saved.') }, 'Save')));
    }
  }, tab);
  w.body.append(...tb.el);
  views.set('settings', () => tb.redraw());
}

// ---- limits ----

const NAME = { claude: 'Claude', codex: 'Codex' };
let refreshing = false;
/** `force` asks the CLIs again; otherwise the daemon answers from its 5 min cache. */
async function refreshLimits(force = false) {
  refreshing = true;
  views.get('settings')?.();
  views.get('limits')?.();
  try {
    limits = await api('GET', `/limits${force ? '?refresh=1' : ''}`);
  } catch (e) {
    limits = { rows: [], errors: Object.fromEntries(CLIS.map((c) => [c, e.message])), fetched_at: null };
  } finally {
    refreshing = false;
  }
  taskbar();
  views.get('settings')?.();
  views.get('limits')?.();
}
const pct = (r) => Math.round(r.used / r.limit * 100);
const worst = () => limits?.rows.reduce((a, r) => (!a || r.used / r.limit > a.used / a.limit ? r : a), null);
const resets = (r) => (!r.resets_at ? '' : /^\d{4}-/.test(r.resets_at) ? fmt(r.resets_at) : r.resets_at); // Claude's is already text

/** One table per CLI, or why it has none, and Refresh. Settings → Limits and the Limits window both draw this. */
function limitsPanel(p) {
  p.replaceChildren(
    ...CLIS.map((c) => {
      const rows = limits?.rows.filter((r) => r.cli === c) ?? [];
      return h('fieldset', { 'data-cli': c }, h('legend', {}, NAME[c]),
        rows.length ? table(['Window', 'Used', '', 'Resets'], rows.map((r) => h('tr', {}, h('td', {}, r.window), h('td', {}, `${pct(r)}%`),
          h('td', {}, h('div', { class: 'progress-indicator k95-meter' }, h('span', { class: 'progress-indicator-bar', style: `width: ${Math.min(100, pct(r))}%` }))),
          h('td', {}, resets(r)))))
          : h('p', {}, limits?.errors[c] ? `Not available: ${limits.errors[c]}` : 'Not read yet.'));
    }),
    h('div', { class: 'field-row' }, h('button', { disabled: refreshing, onclick: () => refreshLimits(true) }, refreshing ? 'Refreshing…' : 'Refresh'),
      h('span', {}, limits?.fetched_at ? `Read ${fmt(limits.fetched_at)}; every 5 minutes while the board is open.` : '')));
}

/** A small window to keep open beside the board. */
function openLimits() {
  const w = open('limits', { title: 'Limits', w: 420, h: 300, persist: true, icon: 'limits', onClose: () => views.delete('limits') });
  if (w.body.firstChild) return;
  views.set('limits', () => limitsPanel(w.body.firstChild));
  w.body.append(h('div', { class: 'k95-limits' }));
  limitsPanel(w.body.firstChild);
}

// ---- notepad ----

/** The operator's scratch text, <repo>/.kanban95/notepad.md. Saved 500 ms after the last keystroke and on close. */
function openNotepad() {
  let timer = null;
  const text = h('textarea', { spellcheck: 'false', readonly: true });
  const status = h('p', { class: 'status-bar-field' }, 'Loading…');
  const save = async () => {
    clearTimeout(timer);
    timer = null;
    try {
      await api('PUT', '/notepad', { value: text.value });
      status.textContent = 'Saved.';
    } catch (e) {
      status.textContent = `Not saved: ${e.message}`;
    }
  };
  const w = open('notepad', { title: 'Notepad', w: 520, h: 380, persist: true, icon: 'notepad', onClose: () => timer && save() });
  if (w.body.firstChild) return;
  text.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  });
  // The selection, or everything when nothing is selected.
  const picked = () => text.value.slice(text.selectionStart, text.selectionEnd) || text.value;
  w.body.append(h('div', { class: 'k95-notepad' }, text),
    h('div', { class: 'field-row' },
      h('button', { onclick: () => newBrainstorm(picked()) }, 'New brainstorm from selection'),
      h('button', { onclick: () => navigator.clipboard.writeText(picked()).then(() => { status.textContent = 'Copied.'; }, (e) => { status.textContent = e.message; }) }, 'Copy')),
    h('div', { class: 'status-bar' }, status));
  api('GET', '/notepad').then(({ value }) => {
    text.value = value;
    text.readOnly = false;
    status.textContent = '.kanban95/notepad.md';
  }, (e) => { status.textContent = e.message; });
}

// ---- startup layout ----

// Which of these windows `boot` opens and where: [{ id, x, y, w, h, max? }], bottom-most first, in ui.json as `k95.layout`.
// The layout says which windows open at start; where is each window's own remembered place, or the layout's for a window
// the operator has not moved (`seed`: not saved, so the default follows the desktop's size at every start).
// Reset forgets the layout windows' places, so the default applies in full from the next start.
const LAYOUT = { board: openBoard, inbox: openInbox, notepad: openNotepad, brain: openBrain, settings: () => openSettings() };
const NAMES = { board: 'Board', inbox: 'Inbox', notepad: 'Notepad', brain: 'Brain', settings: 'Settings' };
/** The action column: Board in the top right, Inbox under it in the bottom right, Notepad left of the Inbox at its height,
 *  together half the desktop's width (the other half is the terminals' region, wm.js → SLOTS), and clear of the desktop
 *  icons on a small desktop. */
function defaultLayout() {
  const d = document.getElementById('desktop');
  const W = d.clientWidth;
  const H = d.clientHeight;
  const icons = document.getElementById('icons');
  const free = W - (icons ? icons.offsetLeft + icons.offsetWidth + 4 : 0);
  const bw = Math.min(Math.round(W / 2), free), bh = Math.round(H * 0.6);
  const iw = Math.round(bw / 2), nw = bw - iw, ih = H - bh;
  return [{ id: 'inbox', x: W - iw, y: bh, w: iw, h: ih }, { id: 'notepad', x: W - bw, y: bh, w: nw, h: ih }, { id: 'board', x: W - bw, y: 0, w: bw, h: bh }];
}
function startupLayout() {
  const l = ui.get('k95.layout');
  if (Array.isArray(l)) return l.filter((x) => LAYOUT[x?.id] && [x.x, x.y, x.w, x.h].every(Number.isFinite));
  return defaultLayout();
}
function saveLayout() {
  const l = snapshot(Object.keys(LAYOUT));
  ui.set('k95.layout', l);
  say(l.length ? `Startup layout saved: ${l.map((x) => NAMES[x.id]).join(', ')}.` : 'Startup layout saved: no windows open at startup.');
}
function resetLayout() {
  ui.set('k95.layout', undefined);
  for (const id of Object.keys(LAYOUT)) forget(id);
  say('Startup layout reset: Board top right, Inbox bottom right, Notepad beside it from the next start.');
}

/** Start → Close ended terminals: the windows of sessions that ended; the live ones take the freed slots. */
function closeEnded() {
  for (const wid of [...terms.keys()]) if (document.querySelector(`[data-win="${wid}"]`)?.classList.contains('ended')) close(wid);
}

// ---- taskbar, keyboard, start ----

const START = [
  { label: 'Board', run: openBoard },
  { label: 'Inbox', run: openInbox },
  { label: 'Brain', run: openBrain },
  { label: 'Settings', run: () => openSettings() },
  { label: 'Notepad', run: openNotepad },
  { label: 'Limits', run: openLimits },
  { label: 'Projects', get items() { return projectItems; } },
  '-',
  { label: 'New ticket', run: () => openTicket(null) },
  { label: 'New brainstorm', run: newBrainstorm },
  { label: 'New operator terminal', run: newOperator },
  { label: 'Close ended terminals', run: closeEnded },
  { get label() { return runner.on ? 'Stop' : 'Run'; }, run: toggleRunner },
  { label: 'Housekeeping', run: housekeeping },
  '-',
  { label: 'Save startup layout', run: saveLayout },
  { label: 'Reset startup layout', run: resetLayout },
  { get label() { return document.fullscreenElement ? 'Exit full screen' : 'Full screen'; }, run: toggleFullscreen },
  { label: 'Restart board', run: restartBoard },
];

/** Desktop icons for the Start menu's first entries, under every window: click selects, double-click or Enter opens. The same
 *  entries are pinned to the taskbar after Start, one click each, as Quick Launch was. */
function desktopIcons() {
  const run = Object.fromEntries(START.filter((s) => s.run).map((s) => [s.label, s.run]));
  const labels = ['Board', 'Inbox', 'Brain', 'Settings', 'Notepad', 'Limits', 'New ticket', 'New brainstorm'];
  const img = (label, size) => h('img', { src: `icons/${label.toLowerCase().replace(' ', '-')}.svg`, alt: '', width: size, height: size, draggable: 'false' });
  const icon = (label) => h('div', { class: 'k95-icon', role: 'button', tabindex: 0, 'data-icon': label,
    ondblclick: run[label], onkeydown: (e) => e.key === 'Enter' && run[label]() },
  img(label, 32), h('span', {}, label));
  document.getElementById('desktop').prepend(h('nav', { id: 'icons' }, labels.map(icon)));
  document.getElementById('pinned').append(...labels.map((label) =>
    h('button', { 'data-pin': label, title: label, 'aria-label': label, onclick: run[label] }, img(label, 16))));
}

function taskbar() {
  document.getElementById('agents').textContent = `${sessions.length} agent${sessions.length === 1 ? '' : 's'}`;
  const q = document.getElementById('inbox-count');
  q.textContent = `Inbox ${inbox.length}`;
  q.classList.toggle('flag', inbox.length > 0);
  document.getElementById('restart-badge').hidden = !runner.stale;
  // The most constrained window of any CLI, e.g. "Claude 62%"; the tooltip lists them all.
  const l = document.getElementById('limits'), r = worst();
  l.textContent = r ? `${NAME[r.cli]} ${pct(r)}%` : limits ? 'Limits ?' : 'Limits';
  l.title = limits ? [...limits.rows.map((x) => `${NAME[x.cli]} ${x.window}: ${pct(x)}%`), ...Object.entries(limits.errors).map(([c, e]) => `${NAME[c]}: ${e}`)].join('\n') : 'Reading usage limits…';
  l.classList.toggle('flag', !!r && pct(r) >= 90);
}

const clock = () => { document.getElementById('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

// Esc closes the focused window, Ctrl+L turns the runner on or off, Ctrl+A selects every card the filter shows in an open column on a focused Board,
// Ctrl+F focuses the Board's filter, Ctrl+N starts a brainstorm, Ctrl+Shift+N an operator terminal, Ctrl+R restarts the focused
// ticket's agent, Ctrl+= (or Ctrl++) and Ctrl+- zoom the UI and Ctrl+0 resets it. Inside a terminal every key goes to the agent
// instead (Esc interrupts Claude Code, Ctrl+L clears the screen, Ctrl+- and Ctrl+= are the agent's).
/** Start → Full screen, or F11: the page's fullscreen, which the shell turns into a borderless window over the whole screen. */
function toggleFullscreen() { // a declaration: START, built at load, refers to it
  (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch((e) => say(`Full screen failed: ${e.message}`));
}

addEventListener('keydown', (e) => {
  if (e.key === 'F11') { // before the terminal and dialog checks: it works everywhere
    e.preventDefault();
    return toggleFullscreen();
  }
  if (document.querySelector('dialog[open]') || e.target.closest?.('.xterm')) return;
  const plainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey;
  if (e.key === 'Escape') {
    const m = document.querySelector('.k95-menu');
    if (m) return m.remove();
    const w = focused();
    if (w) close(w.el.dataset.win);
  } else if (plainCtrl && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    toggleRunner();
  } else if (plainCtrl && e.key.toLowerCase() === 'a' && focused()?.el.dataset.win === 'board' && !e.target.closest?.('input, textarea, select, [contenteditable]')) {
    e.preventDefault();
    for (const t of tickets.values()) if (shown(t) && !collapsed.has(t.status)) selection.add(t.id);
    drawBoard();
  } else if (plainCtrl && e.key.toLowerCase() === 'f' && focused()?.el.dataset.win === 'board') {
    e.preventDefault(); // not the page's find bar
    focused().el.querySelector('.k95-filter').select();
  } else if (plainCtrl && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newBrainstorm();
  } else if (plainCtrl && e.key.toLowerCase() === 'r') {
    const id = /^ticket-(\d+)$/.exec(focused()?.el.dataset.win)?.[1];
    if (!id) return;
    e.preventDefault(); // not a page reload
    restart(Number(id));
  } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newOperator();
  } else if (e.ctrlKey && !e.altKey && ['=', '+', '-', '0'].includes(e.key)) {
    e.preventDefault(); // not the webview's own zoom
    if (e.key === '0') zoomTo(1);
    else zoomStep(e.key === '-' ? -1 : 1);
  }
});

// Ctrl+V with a file on the clipboard (a screenshot) attaches it to the focused Ticket window, unless a text field has focus.
addEventListener('paste', (e) => {
  const id = /^ticket-(\d+)$/.exec(focused()?.el.dataset.win)?.[1];
  if (!id || !e.clipboardData.files.length || e.target.closest?.('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  attach(Number(id), [...e.clipboardData.files]);
});

async function boot() {
  const start = document.getElementById('start');
  start.addEventListener('click', () => {
    loadProjectItems(); // for the next opening; this one shows the list as last read
    const m = menu(0, 0, START);
    const r = start.getBoundingClientRect();
    Object.assign(m.style, { left: `${r.left / scale()}px`, top: `${r.top / scale() - m.offsetHeight}px` });
  });
  document.getElementById('inbox-count').addEventListener('click', openInbox);
  document.getElementById('restart-badge').addEventListener('click', restartBoard);
  document.getElementById('limits').addEventListener('click', () => openSettings('Limits'));
  desktopIcons();
  loadProjectItems();
  addEventListener('focus', loadProjectItems);
  clock();
  setInterval(clock, 10_000);
  refreshLimits(); // a CLI start each, ~10 s: not awaited
  setInterval(refreshLimits, 5 * 60_000); // the daemon's cache lives as long, so this reads fresh numbers
  listen();
  paintProject().catch((e) => say(e.message));
  const [list, st, md] = await Promise.all([api('GET', '/tickets'), api('GET', '/config/settings'), api('GET', '/config/models').catch(() => ({ value: null })), ui.load()]);
  for (const s of ui.get('k95.collapsed') ?? ['done']) collapsed.add(s); // nothing saved: Done starts folded
  Object.assign(view, ui.get('k95.view'));
  for (const t of list) tickets.set(t.id, t);
  settings = { ...settings, ...st.value, voice: { ...settings.voice, ...st.value?.voice }, housekeeping: { ...settings.housekeeping, ...st.value?.housekeeping },
    terminals: { auto: ['plan', 'execute', 'test'], tile: true, ...st.value?.terminals } };
  models = md.value;
  configure(settings.voice);
  applyZoom(settings.zoom);
  setTiling(settings.terminals.tile);
  micEverywhere();
  for (const { id, ...r } of startupLayout()) {
    seed(id, r);
    LAYOUT[id]();
  }
  await refreshShared();
  redraw(null);
  if (!models) say('No model catalog yet: Start → Settings → Models, then Save, before launching.');
}

boot();
