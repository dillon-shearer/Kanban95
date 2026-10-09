// UI state the board keeps across restarts: <repo>/.kanban95/ui.json through GET/PUT /api/ui, not browser storage: the daemon binds
// a new port each start, and per-origin storage started empty every time. Keys: `k95.win.<id>` (wm.js window places),
// `k95.layout` (the startup layout), `k95.collapsed` (folded Board columns) and `k95.view` (the Board's filter, sort and group), in app.js.
// One cache, loaded once before any window opens; each change is written whole 500 ms after the last one, and on pagehide.
let cache = {};
let timer = null;

const write = (keepalive = false) => {
  clearTimeout(timer);
  timer = null;
  return fetch('/api/ui', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cache), keepalive })
    .catch(() => { /* daemon gone: this change is lost, the last write stands */ });
};

/** Reads ui.json into the cache. A failed read leaves it empty: windows open at their defaults. */
export async function load() {
  try {
    const r = await fetch('/api/ui');
    if (r.ok) cache = await r.json();
  } catch { /* defaults */ }
}

export const get = (key) => cache[key] ?? null;

/** Sets `key` (undefined removes it) and schedules the write. */
export function set(key, value) {
  if (value === undefined) delete cache[key];
  else cache[key] = value;
  clearTimeout(timer);
  timer = setTimeout(write, 500);
}

// Only a pending change is flushed: the page's cache is not newer than the file otherwise.
addEventListener('pagehide', () => { if (timer) write(true); });
