// Kanban95 UI: the data layer over /api and the /events websocket, and the windows built on it (Board, Ticket, Terminal,
// Brain, Settings, Inbox). An event names one ticket (or, with null, the set of live sessions); each open window redraws
// only when the event concerns it. Nothing here reloads the page.
import { FitAddon } from './vendor/xterm/addon-fit.mjs';
import { Terminal } from './vendor/xterm/xterm.mjs';
import { configure, ensureModel, micButton, micEverywhere } from './voice.js';
import { close, dialog, focus, focused, h, isOpen, menu, open } from './wm.js';

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
const PHASES = ['plan', 'execute', 'test'];
const CLIS = ['claude', 'codex'];
/** Where the operator may drag a ticket. Everything onward is the agents' job; anything may go back to Backlog (reset). */
const MOVES = { backlog: ['in_progress'], in_progress: ['backlog'], testing: ['backlog'], done: ['backlog'] };

const tickets = new Map();
let sessions = [];
let inbox = [];
let models = null; // ~/.kanban95/models.json as written, for the cards' default model and effort
let settings = { paths: {}, sounds: true, voice: { backend: 'local', mode: 'push' } };
const views = new Map(); // open window id → redraw(ticketId | null)

async function refreshTicket(id) {
  try {
    const was = tickets.get(id)?.flags.needs_human;
    const t = await api('GET', `/tickets/${id}`);
    tickets.set(id, t);
    if (t.flags.needs_human && !was) say(await flagReason(id));
  } catch (e) {
    if (e.status !== 404) throw e;
    tickets.delete(id); // deleted: it leaves the board
  }
}
async function refreshShared() {
  [sessions, inbox] = await Promise.all([api('GET', '/sessions'), api('GET', '/inbox')]);
  openNewTerminals();
  taskbar();
}
const redraw = (ticket) => views.forEach((f) => f(ticket));

function listen() {
  const ws = new WebSocket(`ws://${location.host}/events`);
  ws.onmessage = async (m) => {
    const e = JSON.parse(m.data);
    if (e.sound) {
      if (settings.sounds) new Audio(`sounds/${e.sound}.wav`).play().catch(() => {});
      return;
    }
    if (e.ticket != null) await refreshTicket(e.ticket);
    await refreshShared();
    redraw(e.ticket);
  };
  // ponytail: no reconnect; the daemon lives exactly as long as the window (shell sidecar).
  ws.onclose = () => say('Lost the connection to the daemon. Restart Kanban95.');
}

// ---- board ----

let selected = null;
let say = (msg) => console.log(msg); // the Board's status bar while it is open

const defaults = (t) => models?.[t.cli ?? models.cli]?.execute ?? {};
const badge = (text, cls = '') => h('span', { class: `badge ${cls}` }, text);
const live = (ticketId) => sessions.filter((s) => s.ticket_id === ticketId);

function card(t) {
  const d = defaults(t);
  const el = h('div', {
    class: `card${t.id === selected ? ' selected' : ''}${t.flags.needs_human ? ' alert' : ''}`, 'data-id': t.id, tabindex: 0,
    onclick: () => { selected = t.id; drawBoard(); },
    ondblclick: () => openTicket(t.id),
    oncontextmenu: (e) => { e.preventDefault(); cardMenu(t, e.clientX, e.clientY); },
  },
  h('div', { class: 'card-title' }, h('b', {}, `#${t.id}`), ' ', t.title),
  h('div', { class: 'badges' },
    badge(t.model ?? d.model ?? 'no model', t.model ? '' : 'default'),
    badge(t.effort ?? d.effort ?? 'medium', t.effort ? '' : 'default'),
    badge(t.cli ?? models?.cli ?? 'cli?', t.cli ? '' : 'default'),
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
      Object.assign(ghost.style, { left: `${m.clientX - 16}px`, top: `${m.clientY - 8}px` });
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
  if (to === 'backlog') return reset(t);
  await act(() => api('PATCH', `/tickets/${t.id}`, { status: to }), `#${t.id} moved to ${LABEL[to]} by hand; no agent was started.`);
}

/** Back to Backlog, flags and retries cleared. A running agent is stopped after the move, so its exit flags nothing. */
async function reset(t) {
  const running = live(t.id);
  if (running.length && (await dialog('Reset ticket', `#${t.id} has a running agent. Stop it and move the ticket to Backlog?`, ['Reset', 'Cancel'])) !== 'Reset') return;
  await act(async () => {
    await api('PATCH', `/tickets/${t.id}`, { status: 'backlog', needs_human: false, blocked_on_deps: false, retry: 0 });
    for (const s of running) await api('DELETE', `/grants/${s.grant_id}`).catch(() => {});
  }, `#${t.id} reset to Backlog.`);
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
async function sayLaunched(ids) {
  for (const id of ids) await refreshTicket(id);
  const flagged = ids.find((id) => tickets.get(id)?.flags.needs_human);
  if (flagged != null) return say(await flagReason(flagged));
  say(ids.length ? `Launched ${ids.map((id) => `#${id}`).join(', ')}.` : 'Nothing in Backlog.');
}
const launch = (id) => act(async () => {
  await api('POST', `/tickets/${id}/launch`);
  await sayLaunched([id]);
});
const launchAll = () => act(async () => sayLaunched((await api('POST', '/tickets/launch-all')).map((t) => t.id)));
const newBrainstorm = () => act(async () => openTerminal(await api('POST', '/brainstorm')), 'Brainstorm started.');
const housekeeping = () => act(async () => {
  const t = await api('POST', '/tickets/housekeeping');
  say(`Housekeeping ticket #${t.id} created and launched.`);
});

function cardMenu(t, x, y) {
  const set = (body) => act(() => api('PATCH', `/tickets/${t.id}`, body));
  const cli = t.cli ?? models?.cli;
  const known = [...new Set(PHASES.map((p) => models?.[cli]?.[p]?.model).filter(Boolean))];
  menu(x, y, [
    { label: 'Open', run: () => openTicket(t.id) },
    { label: 'Launch', disabled: t.status !== 'backlog', run: () => launch(t.id) },
    '-',
    { label: 'Model', items: [
      { label: `Phase default${t.model ? '' : ' ✓'}`, run: () => set({ model: null }) },
      ...known.map((m) => ({ label: `${m}${t.model === m ? ' ✓' : ''}`, run: () => set({ model: m }) })),
      { label: 'Other…', run: async () => {
        const input = h('input', { type: 'text', 'data-mic': 'off', value: t.model ?? '', size: 32 });
        if ((await dialog(`Model for #${t.id}`, h('div', { class: 'field-row-stacked' }, h('label', {}, 'Model id'), input), ['OK', 'Cancel'])) === 'OK') {
          set({ model: input.value.trim() || null });
        }
      } },
    ] },
    { label: 'Effort', items: [
      { label: `Phase default${t.effort ? '' : ' ✓'}`, run: () => set({ effort: null }) },
      ...EFFORTS.map((e) => ({ label: `${e}${t.effort === e ? ' ✓' : ''}`, run: () => set({ effort: e }) })),
    ] },
    { label: 'CLI', items: [
      { label: `Default${t.cli ? '' : ' ✓'}`, run: () => set({ cli: null }) },
      ...CLIS.map((c) => ({ label: `${c}${t.cli === c ? ' ✓' : ''}`, run: () => set({ cli: c }) })),
    ] },
    '-',
    { label: 'Retry merge', disabled: !(t.status === 'done' && !t.merged_at), run: () => act(() => api('POST', `/tickets/${t.id}/merge`), `Merge of #${t.id} queued.`) },
    { label: 'Reset to Backlog', disabled: t.status === 'backlog' && !t.flags.blocked_on_deps, run: () => reset(t) },
    { label: 'Delete', run: async () => {
      if ((await dialog('Delete ticket', `Delete #${t.id} ${t.title}? Its notes and runs go with it.`, ['Delete', 'Cancel'])) === 'Delete') {
        act(() => api('DELETE', `/tickets/${t.id}`), `#${t.id} deleted.`);
      }
    } },
  ]);
}

function openBoard() {
  const w = open('board', { title: 'Board', w: 1000, h: 560, persist: true, onClose: () => { views.delete('board'); say = console.log; } });
  if (w.body.firstChild) return;
  const status = h('p', { class: 'status-bar-field', role: 'status' }, 'Ready');
  const count = h('p', { class: 'status-bar-field k95-count' });
  const cols = h('div', { class: 'k95-columns' });
  w.body.classList.add('k95-board');
  w.body.append(
    h('div', { class: 'k95-toolbar' },
      h('button', { onclick: () => (selected ? launch(selected) : say('Select a Backlog ticket first.')) }, 'Launch'),
      h('button', { onclick: launchAll, title: 'Ctrl+L' }, 'Launch all'),
      h('button', { onclick: newBrainstorm, title: 'Ctrl+N' }, 'New brainstorm'),
      h('button', { onclick: () => openTicket(null) }, 'New ticket'),
      h('button', { onclick: housekeeping }, 'Housekeeping')),
    cols,
    h('div', { class: 'status-bar' }, status, count));
  say = (msg) => { status.textContent = msg; status.title = msg; };
  views.set('board', () => {
    const all = [...tickets.values()];
    // A rebuild resets each column's scroll and drops focus; carry both across by status and card id.
    const scroll = Object.fromEntries([...cols.querySelectorAll('.col')].map((c) => [c.dataset.status, c.querySelector('.cards').scrollTop]));
    const focused = document.activeElement?.closest?.('.card');
    const focus = focused && cols.contains(focused) ? [focused.closest('.col').dataset.status, focused.dataset.id] : null;
    cols.replaceChildren(...COLUMNS.map(([s, label]) => {
      const list = all.filter((t) => t.status === s);
      return h('fieldset', { class: 'col', 'data-status': s }, h('legend', {}, `${label} (${list.length})`), h('div', { class: 'cards' }, list.map(card)));
    }));
    for (const c of cols.querySelectorAll('.col')) c.querySelector('.cards').scrollTop = scroll[c.dataset.status] ?? 0;
    if (focus) cols.querySelector(`.col[data-status="${focus[0]}"] .card[data-id="${focus[1]}"]`)?.focus();
    count.textContent = `${all.length} tickets · ${sessions.length} agents`;
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
function tabs(names, draw) {
  let current = names[0];
  const bar = h('menu', { role: 'tablist' });
  const panel = h('div', { class: 'window k95-panel', role: 'tabpanel' }, h('div', { class: 'window-body' }));
  const show = (n) => {
    current = n;
    bar.replaceChildren(...names.map((x) => h('li', { role: 'tab', 'aria-selected': x === n ? 'true' : 'false' },
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); show(x); } }, x))));
    draw(n, panel.firstChild, true);
  };
  show(current);
  return { el: [bar, panel], show: () => show(current), redraw: () => draw(current, panel.firstChild, false) };
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
  const w = open(wid, { title: id ? `Ticket #${id}` : 'New ticket', w: 680, h: 480, onClose: () => views.delete(wid) });
  if (w.body.firstChild) return;
  if (id === null) return w.body.append(ticketForm(w, null));
  const tb = tabs(['Ticket', 'Notes', 'Runs', 'Diff', 'Grants', 'Audit'], async (tab, p, first) => {
    const t = tickets.get(id);
    if (!t) return p.replaceChildren(h('p', {}, 'This ticket was deleted.'));
    w.title(`Ticket #${id} — ${t.title}`);
    if (tab === 'Ticket') {
      // The form is built when the tab is shown, so an event never overwrites what the operator is typing.
      if (first) p.replaceChildren(ticketForm(w, t));
      else p.querySelector('.k95-facts')?.replaceWith(facts(t));
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
}

function facts(t) {
  return h('p', { class: 'k95-facts' }, LABEL[t.status], t.flags.needs_human && ' · needs human', t.flags.blocked_on_deps && ' · waiting on dependencies',
    ` · retry ${t.retry}`, t.template === 'housekeeping' && ' · housekeeping', t.merged_at && ` · merged ${fmt(t.merged_at)}`);
}

/** The ticket's own fields: edits an existing ticket, or creates one (`t` null) and swaps the window for the new ticket's. */
function ticketForm(w, t) {
  const title = h('input', { type: 'text', value: t?.title ?? '' });
  const body = h('textarea', { rows: 6 }, t?.body ?? '');
  const criteria = h('textarea', { rows: 5 }, t?.criteria ?? '');
  const deps = h('input', { type: 'text', 'data-mic': 'off', value: t?.depends_on.join(', ') ?? '', placeholder: 'e.g. 3, 4' });
  const save = async () => {
    const fields = { title: title.value, body: body.value, criteria: criteria.value, depends_on: deps.value.split(/[\s,]+/).filter(Boolean).map(Number) };
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
    h('div', { class: 'field-row-stacked' }, h('label', {}, 'Depends on'), deps),
    h('div', { class: 'field-row' }, h('button', { onclick: save }, t ? 'Save' : 'Create'),
      t && h('button', { disabled: t.status !== 'backlog', onclick: () => launch(t.id) }, 'Launch')));
}

// ---- terminals ----

const seen = new Set();
function openNewTerminals() {
  for (const s of sessions) if (!seen.has(s.id)) openTerminal(s, true);
}

/**
 * A run's terminal. The board opens one for every new session on its own (`auto`): behind the focused window, and closed
 * again shortly after its agent reports (submit, pass, fail). One that was revoked or died stays open, marked ended.
 */
function openTerminal(s, auto = false) {
  seen.add(s.id);
  const wid = `term-${s.id}`;
  if (isOpen(wid)) return focus(wid);
  const title = s.ticket_id === null ? `Brainstorm — ${s.model}` : `#${s.ticket_id} — ${s.phase} — ${s.model}`;
  const ws = new WebSocket(`ws://${location.host}/pty/${s.id}`);
  const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  const term = new Terminal({ fontFamily: 'Consolas, "Courier New", monospace', fontSize: 13, scrollback: 5000 });
  const fit = new FitAddon();
  const ro = new ResizeObserver(() => fit.fit());
  // Spoken words are typed into the agent's terminal without Enter; the operator presses it.
  const w = open(wid, { title, w: 760, h: 440, background: auto, extra: [micButton((text) => send({ data: text }))], onClose: () => { ro.disconnect(); ws.close(); term.dispose(); } });
  w.body.classList.add('k95-term');
  term.loadAddon(fit);
  term.open(w.body);
  ws.onmessage = (m) => term.write(m.data);
  ws.onopen = () => { fit.fit(); send({ resize: [term.cols, term.rows] }); };
  ws.onclose = () => {
    term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
    w.title(`${title} (ended)`);
    w.el.classList.add('ended');
    if (!auto || s.run_id === null) return;
    // The run's outcome is written as its terminal closes; its output stays in Ticket → Runs.
    setTimeout(async () => {
      const run = (await api('GET', `/tickets/${s.ticket_id}/runs`).catch(() => [])).find((r) => r.id === s.run_id);
      if (['submit', 'pass', 'fail'].includes(run?.outcome)) setTimeout(w.close, 1500);
    }, 500);
  };
  term.onData((d) => send({ data: d }));
  term.onResize(({ cols, rows }) => send({ resize: [cols, rows] }));
  ro.observe(w.body);
}

// ---- brain ----

function openBrain() {
  const w = open('brain', { title: 'Brain', w: 560, h: 460, persist: true });
  if (w.body.firstChild) return;
  const q = h('input', { type: 'search', placeholder: 'Search notes' });
  const results = h('ol', { class: 'k95-notes' });
  const search = async () => {
    const rows = await api('GET', `/brain?q=${encodeURIComponent(q.value)}`);
    results.replaceChildren(...(rows.length ? rows.map((b) => h('li', { class: 'note' },
      h('div', { class: 'note-head' }, `#${b.id} ${b.title}`, b.ticket_id && ` · ticket #${b.ticket_id}`, b.tags && ` · ${b.tags}`),
      h('pre', {}, b.body))) : [h('li', {}, 'Nothing found.')]));
  };
  const title = h('input', { type: 'text', placeholder: 'Title' });
  const tags = h('input', { type: 'text', 'data-mic': 'off', placeholder: 'tags' });
  const body = h('textarea', { rows: 3, placeholder: 'What the next agent should know' });
  const add = () => act(async () => {
    await api('POST', '/brain', { title: title.value, body: body.value, tags: tags.value });
    title.value = body.value = tags.value = '';
    await search();
  }, 'Note added to the brain.');
  q.addEventListener('keydown', (e) => e.key === 'Enter' && search());
  w.body.classList.add('k95-brain');
  w.body.append(h('div', { class: 'field-row' }, q, h('button', { onclick: search }, 'Search')), results,
    h('fieldset', {}, h('legend', {}, 'Add note'), h('div', { class: 'field-row' }, title, tags), h('div', { class: 'field-row' }, body), h('button', { onclick: add }, 'Add')));
  search();
}

// ---- inbox ----

function openInbox() {
  const w = open('inbox', { title: 'Inbox', w: 560, h: 400, persist: true, onClose: () => views.delete('inbox') });
  if (w.body.firstChild) return;
  let shown = null;
  const draw = () => {
    const ids = inbox.map((q) => q.id).join();
    if (ids === shown) return; // unchanged: keep whatever the operator is typing
    shown = ids;
    w.body.replaceChildren(...(inbox.length ? inbox.map((q) => {
      const answer = h('textarea', { rows: 3, placeholder: 'Your answer' });
      return h('fieldset', { class: 'k95-question', 'data-ticket': q.ticket_id }, h('legend', {}, `#${q.ticket_id} ${q.title}`),
        h('div', { class: 'note-head' }, `${fmt(q.created_at)} · the ${q.role} asks:`), h('pre', {}, q.body),
        h('div', { class: 'field-row' }, answer),
        h('button', { onclick: () => act(() => api('POST', `/tickets/${q.ticket_id}/answer`, { answer: answer.value }), `Answer sent to #${q.ticket_id}.`) }, 'Answer'));
    }) : [h('p', {}, 'No open questions.')]));
  };
  views.set('inbox', draw);
  draw();
}

// ---- settings ----

async function saveSettings(patch) {
  settings = (await api('PUT', '/config/settings', { ...settings, ...patch })).value;
  configure(settings.voice);
}

function grantTable(grants) {
  return table(['Grant', 'Ticket', 'Role', 'Session', 'Expires', ''], grants.map((g) => {
    const s = sessions.find((x) => x.grant_id === g.id);
    return h('tr', {}, h('td', {}, g.id), h('td', {}, g.ticket_id ? `#${g.ticket_id}` : 'brainstorm'), h('td', {}, g.role),
      h('td', {}, s ? `${s.phase} · ${s.model}` : 'none'), h('td', {}, fmt(g.expires_at)),
      h('td', {}, h('button', { 'data-grant': g.id, onclick: () => act(() => api('DELETE', `/grants/${g.id}`), `Grant ${g.id} revoked; its session was stopped.`) }, 'Revoke')));
  }));
}

function openSettings() {
  const w = open('settings', { title: 'Settings', w: 640, h: 440, persist: true, onClose: () => views.delete('settings') });
  if (w.body.firstChild) return;
  const tb = tabs(['Models', 'CLIs', 'Prompts', 'Grants', 'Voice', 'General'], async (tab, p, first) => {
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
        for (const c of CLIS) for (const ph of PHASES) {
          const { model, effort } = cells[`${c}.${ph}`];
          if (model.value.trim()) (out[c] ??= {})[ph] = { model: model.value.trim(), effort: effort.value };
        }
        models = (await api('PUT', '/config/models', out)).value;
        drawBoard();
      }, `Saved ${path}.`);
      p.replaceChildren(h('p', {}, `Which CLI runs agents, and the model and effort per phase (plan is the brainstorm). A ticket's own model and effort override execute. ${path}`),
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
      const { path, value } = await api('GET', '/config/preferences');
      const text = h('textarea', { id: 'preferences', rows: 10, placeholder: 'e.g. No em dashes or non-ASCII characters in output.' });
      text.value = value;
      p.replaceChildren(h('fieldset', {}, h('legend', {}, 'Preferences'),
        h('p', {}, `Standing instructions every agent prompt gets under "Operator preferences". Up to 16 KB. ${path}`),
        h('div', { class: 'field-row' }, text),
        h('button', { onclick: () => act(() => api('PUT', '/config/preferences', { value: text.value }), `Saved ${path}.`) }, 'Save')));
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
    } else if (tab === 'General') {
      p.replaceChildren(h('div', { class: 'field-row' }, h('input', { type: 'checkbox', id: 'sounds', checked: settings.sounds,
        onchange: (e) => act(() => saveSettings({ sounds: e.target.checked }), 'Saved.') }), h('label', { for: 'sounds' }, 'Sounds: ding when a ticket merges, chord when the board needs you')));
    }
  });
  w.body.append(...tb.el);
  views.set('settings', () => tb.redraw());
}

// ---- taskbar, keyboard, start ----

const START = [
  { label: 'Board', run: openBoard },
  { label: 'Inbox', run: openInbox },
  { label: 'Brain', run: openBrain },
  { label: 'Settings', run: openSettings },
  '-',
  { label: 'New ticket', run: () => openTicket(null) },
  { label: 'New brainstorm', run: newBrainstorm },
  { label: 'Launch all', run: launchAll },
  { label: 'Housekeeping', run: housekeeping },
];

/** Desktop icons for the Start menu's first entries, under every window. Click selects; double-click or Enter opens. */
function desktopIcons() {
  const run = Object.fromEntries(START.filter((s) => s.run).map((s) => [s.label, s.run]));
  const icon = (label) => h('div', { class: 'k95-icon', role: 'button', tabindex: 0, 'data-icon': label,
    ondblclick: run[label], onkeydown: (e) => e.key === 'Enter' && run[label]() },
  h('img', { src: `icons/${label.toLowerCase().replace(' ', '-')}.svg`, alt: '', width: 32, height: 32, draggable: 'false' }),
  h('span', {}, label));
  document.getElementById('desktop').prepend(h('nav', { id: 'icons' },
    ['Board', 'Inbox', 'Brain', 'Settings', 'New ticket', 'New brainstorm'].map(icon)));
}

function taskbar() {
  document.getElementById('agents').textContent = `${sessions.length} agent${sessions.length === 1 ? '' : 's'}`;
  const q = document.getElementById('inbox-count');
  q.textContent = `Inbox ${inbox.length}`;
  q.classList.toggle('flag', inbox.length > 0);
}

const clock = () => { document.getElementById('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

// Esc closes the focused window, Ctrl+L launches all, Ctrl+N starts a brainstorm. Inside a terminal every key goes to the
// agent instead (Esc interrupts Claude Code, Ctrl+L clears the screen).
addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || e.target.closest?.('.xterm')) return;
  const plainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey;
  if (e.key === 'Escape') {
    const m = document.querySelector('.k95-menu');
    if (m) return m.remove();
    const w = focused();
    if (w) close(w.el.dataset.win);
  } else if (plainCtrl && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    launchAll();
  } else if (plainCtrl && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newBrainstorm();
  }
});

async function boot() {
  const start = document.getElementById('start');
  start.addEventListener('click', () => {
    const m = menu(0, 0, START);
    const r = start.getBoundingClientRect();
    Object.assign(m.style, { left: `${r.left}px`, top: `${r.top - m.offsetHeight}px` });
  });
  document.getElementById('inbox-count').addEventListener('click', openInbox);
  desktopIcons();
  clock();
  setInterval(clock, 10_000);
  listen();
  const [list, st, md] = await Promise.all([api('GET', '/tickets'), api('GET', '/config/settings'), api('GET', '/config/models').catch(() => ({ value: null }))]);
  for (const t of list) tickets.set(t.id, t);
  settings = { ...settings, ...st.value, voice: { ...settings.voice, ...st.value?.voice } };
  models = md.value;
  configure(settings.voice);
  micEverywhere();
  openBoard();
  await refreshShared();
  redraw(null);
  if (!models) say('No model catalog yet: Start → Settings → Models, then Save, before launching.');
}

boot();
