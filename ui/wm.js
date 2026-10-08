// Window manager: Win95 MDI windows on #desktop, one taskbar button each, modal dialogs and pop-up menus.
// A window opened with `persist` keeps its position and size in localStorage; the others cascade.
const desktop = document.getElementById('desktop');
const tasks = document.getElementById('tasks');
const wins = new Map(); // id → { el, task, onClose }
let z = 10;
let cascade = 0;

const geo = {
  get: (id) => { try { return JSON.parse(localStorage.getItem(`k95.win.${id}`)); } catch { return null; } },
  set: (id, r) => { try { localStorage.setItem(`k95.win.${id}`, JSON.stringify(r)); } catch { /* storage off: positions reset */ } },
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
  w.el.hidden = false;
  w.el.style.zIndex = ++z;
  w.el.classList.add('active');
  w.el.querySelector('.title-bar').classList.remove('inactive');
  w.task.classList.add('active');
}

/**
 * Opens window `id`, or focuses it when it is already open. Returns { el, body, title(text), close }.
 * `background`: opens behind the focused window without taking focus (terminals the board opens on its own).
 */
export function open(id, { title, w = 480, h: height = 320, persist = false, background = false, onClose, extra = [] }) {
  if (wins.has(id)) {
    focus(id);
    return wins.get(id).api;
  }
  const saved = persist ? geo.get(id) : null;
  const off = (cascade++ % 8) * 24;
  const r = saved ?? { x: 40 + off, y: 20 + off, w, h: height };
  const text = h('div', { class: 'title-bar-text' }, title);
  const body = h('div', { class: 'window-body' });
  const el = h('div', { class: 'window k95-win', 'data-win': id },
    h('div', { class: 'title-bar' }, text, h('div', { class: 'title-bar-controls' }, ...extra,
      h('button', { 'aria-label': 'Minimize', onclick: () => minimize(id) }),
      h('button', { 'aria-label': 'Close', onclick: () => close(id) }))),
    body);
  Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  const task = h('button', { class: 'task', onclick: () => (el.classList.contains('active') && !el.hidden ? minimize(id) : focus(id)) }, title);
  const api = { el, body, title: (t) => { text.textContent = t; task.textContent = t; }, close: () => close(id) };
  wins.set(id, { el, task, onClose, api });
  desktop.append(el);
  tasks.append(task);
  clamp(el);

  const save = () => persist && geo.set(id, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
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

/** Keeps at least the title bar on the desktop. */
function clamp(el) {
  const d = desktop.getBoundingClientRect();
  // Write size only when it overflows: offsetWidth includes padding, so writing it back grows a content-box window.
  if (el.offsetWidth > d.width) el.style.width = `${d.width}px`;
  if (el.offsetHeight > d.height) el.style.height = `${d.height}px`;
  el.style.left = `${Math.max(0, Math.min(el.offsetLeft, d.width - el.offsetWidth))}px`;
  el.style.top = `${Math.max(0, Math.min(el.offsetTop, d.height - 24))}px`;
}

function drag(el, bar, done) {
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const dx = e.clientX - el.offsetLeft;
    const dy = e.clientY - el.offsetTop;
    bar.setPointerCapture(e.pointerId);
    const move = (m) => {
      el.style.left = `${m.clientX - dx}px`;
      el.style.top = `${m.clientY - dy}px`;
      clamp(el);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', () => { bar.removeEventListener('pointermove', move); done(); }, { once: true });
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
  w.el.remove();
  w.task.remove();
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

/** A pop-up menu at (x, y). Items: { label, run } | { label, items } (submenu) | '-' (separator). */
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
  Object.assign(m.style, { left: `${Math.min(x, innerWidth - r.width)}px`, top: `${Math.min(y, innerHeight - r.height)}px` });
  const off = (e) => {
    if (m.contains(e.target)) return;
    m.remove();
    removeEventListener('pointerdown', off, true);
  };
  setTimeout(() => addEventListener('pointerdown', off, true));
  return m;
}
