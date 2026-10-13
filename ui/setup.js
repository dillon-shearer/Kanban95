import { requirementsList } from './requirements.js';

const $ = (id) => document.getElementById(id);
const form = $('setup');
const error = $('error');
$('requirements').append(...requirementsList());

fetch('/api/setup').then((r) => r.json()).then(({ data }) => {
  if (!$('data').value) $('data').value = data;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  $('next').disabled = true;
  const r = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: $('data').value, project: $('project').value }),
  });
  if (r.ok) {
    form.querySelector('.window-body').textContent = 'Starting the board...';
    return;
  }
  error.textContent = (await r.json().catch(() => ({}))).error ?? `Setup failed (${r.status})`;
  error.hidden = false;
  $('next').disabled = false;
});
