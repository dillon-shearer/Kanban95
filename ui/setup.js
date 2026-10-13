import { requirementsList } from './requirements.js';

const $ = (id) => document.getElementById(id);
const form = $('setup');
const error = $('error');
$('requirements').append(...requirementsList());
const missing = !$('retry').hidden;

fetch('/api/setup').then((r) => r.json()).then(({ data }) => {
  if (!$('data').value) $('data').value = data;
});

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
