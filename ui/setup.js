import { requirementsList } from './requirements.js';

const $ = (id) => document.getElementById(id);
const form = $('setup');
const error = $('error');
$('requirements').append(...requirementsList());
const missing = !$('retry').hidden;

fetch('/api/setup').then((r) => r.json()).then(({ data, shell }) => {
  if (!$('data').value) $('data').value = data;
  for (const id of ['data', 'project']) $(`${id}-browse`).hidden = !shell;
});

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function browse(id) {
  const b = $(`${id}-browse`);
  b.disabled = true;
  try {
    const r = await fetch('/api/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'folder' }) });
    const { token, error: refused } = await r.json();
    if (!r.ok) throw new Error(refused);
    let got = { pending: true };
    while (got.pending) {
      await wait(250);
      const p = await fetch(`/api/pick/${token}`);
      if (!p.ok) throw new Error('The dialog ended without an answer.');
      got = await p.json();
    }
    if (got.path) $(id).value = got.path;
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  } finally {
    b.disabled = false;
  }
}
for (const id of ['data', 'project']) $(`${id}-browse`).addEventListener('click', () => browse(id));

async function send(path, body) {
  error.hidden = true;
  $('next').disabled = $('retry').disabled = true;
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.ok) {
    form.querySelector('.window-body').textContent = 'Starting the board...';
    return;
  }
  error.textContent = (await r.json().catch(() => ({}))).error ?? `Setup failed (${r.status})`;
  error.hidden = false;
  $('next').disabled = $('retry').disabled = false;
}

$('retry').addEventListener('click', () => send('/api/setup/retry', {}));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  send('/api/setup', missing ? { data: $('data').value } : { data: $('data').value, project: $('project').value });
});
