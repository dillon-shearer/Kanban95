// Window manager: Win95 MDI windows on #desktop, one taskbar button each, modal dialogs and pop-up menus.
// A window opened with `persist` keeps its position, size and maximized state in ui.json (state.js); one with nothing saved opens
// where it covers the least of the open windows (`place`).
// `persist: true` saves under the window id; a string saves under that key, so windows with different ids can share one place.
// Maximized is the `max` class: CSS fills #desktop over the inline geometry, which stays as the restore geometry.
import * as ui from './state.js';

const desktop = document.getElementById('desktop');
const tasks = document.getElementById('tasks');
const wins = new Map(); // id → { el, task, onClose, api, toggleMax, items }
let z = 10;
// The UI zoom: CSS `zoom` on body, so menus and dialogs appended to it scale too. Inside it, offsets and inline styles (and so
// the saved geometry) are CSS px before zoom, while pointer coordinates and getBoundingClientRect are screen px: divide those by it.
let zoom = 1;
export const scale = () => zoom;

/** Sets the UI zoom and puts every window back on the desktop, which is smaller in CSS px when zoomed in. */
export function setZoom(f) {
  zoom = f;
  document.body.style.zoom = f;
  for (const { el } of wins.values()) if (!el.hidden && !el.classList.contains('max')) clamp(el);
}
// Taskbar selection: Ctrl+click toggles a button, Shift+click takes the range from the last clicked one, in taskbar order.
const sel = new Set();
let anchor = null;
const paint = () => { for (const [id, w] of wins) w.task.classList.toggle('selected', sel.has(id)); };

// Taskbar overflow: once the buttons are at their 60px minimum, arrows at both ends scroll one button per click, as does the wheel.
const arrows = [document.getElementById('tasks-left'), document.getElementById('tasks-right')];
const step = () => (tasks.querySelector('.task')?.offsetWidth ?? 60) + 3; // + the 3px flex gap
arrows.forEach((a, i) => a.addEventListener('click', () => { tasks.scrollLeft += (i ? 1 : -1) * step(); }));
tasks.addEventListener('wheel', (e) => { e.preventDefault(); tasks.scrollLeft += e.deltaY || e.deltaX; }, { passive: false });
const overflow = () => { for (const a of arrows) a.hidden = tasks.scrollWidth <= tasks.clientWidth; };
new ResizeObserver(overflow).observe(tasks);

const geo = {
  get: (id) => ui.get(`k95.win.${id}`),
  set: (id, r) => ui.set(`k95.win.${id}`, r),
};

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
};
export { h };

export const focused = () => [...wins.values()].find((w) => w.el.classList.contains('active'));

export function focus(id) {
  const w = wins.get(id);
  if (!w) return;
  for (const o of wins.values()) {
    o.el.classList.remove('active');
    o.el.querySelector('.title-bar').classList.add('inactive');
    o.task.classList.remove('active');
  }
  if (w.el.hidden) {
    w.el.hidden = false;
    if (!w.el.classList.contains('max')) clamp(w.el); // the zoom may have changed while it was minimized
  }
  w.el.style.zIndex = ++z;
  w.el.classList.add('active');
  w.el.querySelector('.title-bar').classList.remove('inactive');
  w.task.classList.add('active');
  w.task.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * Opens window `id`, or focuses it when it is already open. Returns { el, body, title(text), close }.
 * `background`: opens behind the focused window without taking focus (terminals the board opens on its own).
 * `onX`: runs instead of closing when the operator clicks X; `close` and `api.close` still close at once.
 * `items`: extra entries for its taskbar button's menu, as `menu()` takes them.
 */
export function open(id, { title, w = 480, h: height = 320, persist = false, background = false, onClose, onX, extra = [], items = [] }) {
  if (wins.has(id)) {
    focus(id);
    return wins.get(id).api;
  }
  const key = persist === true ? id : persist;
  const saved = key ? geo.get(key) ?? seeds.get(key) ?? null : null;
  seeds.delete(key);
  const r = saved ?? { ...place(w, height), w, h: height };
  const text = h('div', { class: 'title-bar-text' }, title);
  const body = h('div', { class: 'window-body' });
  const el = h('div', { class: 'window k95-win', 'data-win': id },
    h('div', { class: 'title-bar' }, text, h('div', { class: 'title-bar-controls' }, ...extra,
      h('button', { 'aria-label': 'Minimize', onclick: () => minimize(id) }),
      h('button', { 'aria-label': saved?.max ? 'Restore' : 'Maximize', onclick: () => toggleMax() }),
      h('button', { 'aria-label': 'Close', onclick: () => (onX ? onX() : close(id)) }))),
    body);
  el.classList.toggle('max', !!saved?.max);
  Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  const task = h('button', { class: 'task', 'data-task': id, onclick: (e) => clickTask(id, e),
    oncontextmenu: (e) => { e.preventDefault(); taskMenu(id, e.clientX, e.clientY); },
    onkeydown: (e) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      e.preventDefault();
      const r = task.getBoundingClientRect();
      taskMenu(id, r.left, r.top);
    } }, title);
  dragTask(task);
  const api = { el, body, title: (t) => { text.textContent = t; task.textContent = t; }, close: () => close(id) };
  wins.set(id, { el, task, onClose, api, toggleMax, items });
  desktop.append(el);
  tasks.append(task);
  overflow(); // before focus() scrolls the button into view, so the arrows are already taking their room
  if (!saved?.max) clamp(el); // clamp reads the maximized box and would overwrite the restore geometry

  // Saved only when the geometry changed: a click inside an unmoved window leaves it following its seed (the startup layout).
  let last = JSON.stringify(rect(el));
  const save = () => {
    const now = JSON.stringify(rect(el));
    if (key && now !== last) geo.set(key, JSON.parse((last = now)));
  };
  const maxBtn = el.querySelector('[aria-label="Maximize"], [aria-label="Restore"]');
  function toggleMax() {
    maxBtn.setAttribute('aria-label', el.classList.toggle('max') ? 'Restore' : 'Maximize');
    save();
  }
  el.querySelector('.title-bar').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMax(); });
  el.addEventListener('pointerdown', () => focus(id), true);
  // The window is CSS-resizable (resize: both); its size is saved when the operator lets go.
  el.addEventListener('pointerup', save);
  drag(el, el.querySelector('.title-bar'), save);
  if (!background || !focused()) focus(id);
  else {
    el.style.zIndex = Math.max(1, Number(focused().el.style.zIndex) - 1);
    el.querySelector('.title-bar').classList.add('inactive');
  }
  return api;
}

/**
 * Where a w×h window with no saved geometry opens: of the desktop corners and a grid stepping by half a window, the spot
 * that overlaps the least total area of the open, non-minimized windows; on a tie the top-most, then left-most.
 * With room that is a free spot; on a full desktop, the least covered one.
 */
// ponytail: O(candidates × windows), about (2·W/w)·(2·H/h) candidates, so ~50 × a few dozen windows; fine for a desktop.
// A free-rectangle search would find gaps off the half-window grid if windows ever get many or small.
function place(w, h) {
  const W = desktop.clientWidth;
  const H = desktop.clientHeight;
  const mx = Math.max(0, W - w);
  const my = Math.max(0, H - h);
  const boxes = [...wins.values()].filter((o) => !o.el.hidden)
    .map(({ el }) => [el.offsetLeft, el.offsetTop, el.offsetLeft + el.offsetWidth, el.offsetTop + el.offsetHeight]);
  const xs = new Set([0, mx]);
  const ys = new Set([0, my]);
  for (let x = 0; x < mx; x += w / 2) xs.add(Math.round(x));
  for (let y = 0; y < my; y += h / 2) ys.add(Math.round(y));
  let best = null;
  for (const y of [...ys].sort((a, b) => a - b)) {
    for (const x of [...xs].sort((a, b) => a - b)) {
      let cover = 0;
      for (const [l, t, r, b] of boxes) cover += Math.max(0, Math.min(x + w, r) - Math.max(x, l)) * Math.max(0, Math.min(y + h, b) - Math.max(y, t));
      if (!best || cover < best.cover) best = { x, y, cover };
    }
  }
  return { x: best.x, y: best.y };
}

/** A window's geometry as `open` restores it: the inline restore geometry while maximized (or minimized), else the laid-out box. */
function rect(el) {
  const s = el.style;
  const max = el.classList.contains('max');
  if (max || el.hidden) return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height), ...(max && { max }) };
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

/** The open windows among `ids` with their geometry ({ id, x, y, w, h, max? }), bottom-most first: a startup layout. */
export const snapshot = (ids) => [...wins].filter(([id]) => ids.includes(id))
  .sort(([, a], [, b]) => Number(a.el.style.zIndex) - Number(b.el.style.zIndex))
  .map(([id, { el }]) => ({ id, ...rect(el) }));

// Places for the next `open` of a window with nothing remembered, not saved: the startup layout's, so an unmoved window
// follows the layout (and a default layout the desktop's size) at every start, and its own place once the operator moves it.
const seeds = new Map();
/** Opens window `key` at `r` next time if it has no remembered place. */
export const seed = (key, r) => seeds.set(key, r);
/** Forgets window `key`'s remembered place. */
export const forget = (key) => geo.set(key, undefined);

/** Keeps at least the title bar on the desktop. */
function clamp(el) {
  const d = { width: desktop.clientWidth, height: desktop.clientHeight }; // CSS px, like the window's own offsets
  // Write size only when it overflows: offsetWidth includes padding, so writing it back grows a content-box window.
  if (el.offsetWidth > d.width) el.style.width = `${d.width}px`;
  if (el.offsetHeight > d.height) el.style.height = `${d.height}px`;
  el.style.left = `${Math.max(0, Math.min(el.offsetLeft, d.width - el.offsetWidth))}px`;
  el.style.top = `${Math.max(0, Math.min(el.offsetTop, d.height - 24))}px`;
}

function drag(el, bar, done) {
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button') || el.classList.contains('max')) return;
    const dx = e.clientX / zoom - el.offsetLeft;
    const dy = e.clientY / zoom - el.offsetTop;
    bar.setPointerCapture(e.pointerId);
    const move = (m) => {
      el.style.left = `${m.clientX / zoom - dx}px`;
      el.style.top = `${m.clientY / zoom - dy}px`;
      clamp(el);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', () => { bar.removeEventListener('pointermove', move); done(); }, { once: true });
  });
}

let dragged = false; // a reorder drag ends in a click on the button; that click must not minimize or focus

function clickTask(id, e) {
  if (dragged) return;
  const order = [...tasks.children].map((b) => b.dataset.task);
  if (e.shiftKey && wins.has(anchor)) {
    const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
    sel.clear();
    for (const x of order.slice(a, b + 1)) sel.add(x);
    return paint();
  }
  anchor = id;
  if (e.ctrlKey) {
    if (!sel.delete(id)) sel.add(id);
    return paint();
  }
  sel.clear();
  paint();
  const { el } = wins.get(id);
  if (el.classList.contains('active') && !el.hidden) minimize(id);
  else focus(id);
}

/** Restore takes a window out of minimized or maximized. */
function restore(id) {
  const w = wins.get(id);
  if (w.el.classList.contains('max')) w.toggleMax();
  focus(id);
}

/** The button's menu; on a selected button, the bulk menu for the whole selection. */
function taskMenu(id, x, y) {
  if (sel.has(id) && sel.size > 1) {
    const each = (f) => () => { const ids = [...sel]; sel.clear(); paint(); ids.forEach(f); };
    return menu(x, y, [{ label: 'Restore', run: each(restore) }, { label: 'Minimize', run: each(minimize) }, '-', { label: 'Close', run: each(close) }]);
  }
  sel.clear();
  paint();
  const { el, toggleMax, items } = wins.get(id);
  const max = el.classList.contains('max');
  menu(x, y, [
    { label: 'Restore', disabled: !max && !el.hidden, run: () => restore(id) },
    { label: 'Minimize', disabled: el.hidden, run: () => minimize(id) },
    { label: 'Maximize', disabled: max, run: () => { toggleMax(); focus(id); } },
    ...(items.length ? ['-', ...items] : []),
    '-',
    { label: 'Close', run: () => close(id) },
  ]);
}

/** Drag a button sideways to reorder the taskbar; it swaps with each button the pointer crosses. */
function dragTask(task) {
  task.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    // On window, not pointer capture: moving the button in the DOM drops its capture.
    const move = (m) => {
      if (!dragged && Math.abs(m.clientX - x0) < 5) return;
      dragged = true;
      const over = [...tasks.children].find((b) => { const r = b.getBoundingClientRect(); return m.clientX >= r.left && m.clientX < r.right; });
      if (!over || over === task) return;
      if (task.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING) over.after(task);
      else over.before(task);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', () => {
      removeEventListener('pointermove', move);
      setTimeout(() => { dragged = false; }); // after the click this release makes
    }, { once: true });
  });
}

export function minimize(id) {
  const w = wins.get(id);
  if (!w) return;
  w.el.hidden = true;
  w.el.classList.remove('active');
  w.task.classList.remove('active');
}

export function close(id) {
  const w = wins.get(id);
  if (!w) return;
  wins.delete(id);
  sel.delete(id);
  w.el.remove();
  w.task.remove();
  overflow();
  w.onClose?.();
}

export const isOpen = (id) => wins.has(id);

/** A modal Win95 dialog. Resolves with the label of the button pressed, or null on Esc. `body` is a node or text. */
export function dialog(title, body, buttons = ['OK']) {
  return new Promise((done) => {
    const d = h('dialog', { class: 'window k95-dialog' },
      h('div', { class: 'title-bar' }, h('div', { class: 'title-bar-text' }, title)),
      h('div', { class: 'window-body' }, body,
        h('section', { class: 'field-row k95-buttons' }, buttons.map((b) => h('button', { onclick: () => d.close(b) }, b)))));
    d.addEventListener('close', () => { d.remove(); done(d.returnValue || null); });
    document.body.append(d);
    d.showModal();
    (d.querySelector('input, textarea, select') ?? d.querySelector('.k95-buttons button')).focus();
  });
}

/** A pop-up menu at screen point (x, y), as clientX/clientY and getBoundingClientRect give it. Items: { label, run } | { label, items } (submenu) | '-' (separator). */
export function menu(x, y, items) {
  document.querySelector('.k95-menu')?.remove();
  const build = (list) => h('ul', { class: 'k95-menu', role: 'menu' }, list.map((it) => it === '-'
    ? h('li', { class: 'sep' })
    : h('li', { role: 'menuitem', tabindex: -1, class: it.items ? 'sub' : null, 'aria-disabled': it.disabled || null,
      onclick: (e) => { e.stopPropagation(); if (!it.items && !it.disabled) { m.remove(); it.run(); } } },
    it.label, it.items ? build(it.items) : null)));
  const m = build(items);
  document.body.append(m);
  const r = m.getBoundingClientRect();
  Object.assign(m.style, { left: `${Math.min(x, innerWidth - r.width) / zoom}px`, top: `${Math.min(y, innerHeight - r.height) / zoom}px` });
  const off = (e) => {
    if (m.contains(e.target)) return;
    m.remove();
    removeEventListener('pointerdown', off, true);
  };
  setTimeout(() => addEventListener('pointerdown', off, true));
  return m;
}
