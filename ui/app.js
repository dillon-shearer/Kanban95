const status = document.getElementById('status');
fetch('/health')
  .then((r) => r.json())
  .then((j) => { status.textContent = j.ok ? 'daemon ok' : 'daemon error'; })
  .catch(() => { status.textContent = 'daemon unreachable'; });
