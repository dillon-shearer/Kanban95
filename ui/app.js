const status = document.getElementById('status');
fetch('/health')
  .then((r) => r.json())
  .then((j) => { status.textContent = j.ok ? 'daemon ok' : 'daemon error'; })
  .catch(() => { status.textContent = 'daemon unreachable'; });

// Board events: ding.wav when a ticket is done and merged, chord.wav when one needs the operator.
// ponytail: no reconnect; the daemon lives as long as the window. Phase 6 adds board refresh on the same socket.
new WebSocket(`ws://${location.host}/events`).onmessage = (m) => {
  const e = JSON.parse(m.data);
  if (e.sound === 'ding' || e.sound === 'chord') new Audio(`sounds/${e.sound}.wav`).play().catch(() => {});
};
