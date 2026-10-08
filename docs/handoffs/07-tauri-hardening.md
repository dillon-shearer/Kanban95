# Phase 7 — Tauri hardening and packaging

Read `CLAUDE.md`, `PLAN.md`, `docs/handoffs/log/*`.

## Goal
The shell is a locked box around the daemon. Ship an installer that works on a machine with Node 24 installed, and document the path to bundling Node later.

## Deliverables
- Sidecar lifecycle: daemon started before the window, restarted once if it dies, Win95-style error dialog if it cannot start. Daemon killed on every exit path (close, crash, OS shutdown signal).
- Tauri capabilities: only the commands the UI actually calls. No `shell:open`, no fs scope, no http scope beyond the daemon origin.
- CSP: `default-src 'self' http://127.0.0.1:<port> ws://127.0.0.1:<port>`; no inline script, move anything inline into files. The voice model is served from the daemon, so no model host appears in the CSP. The one-time model download is made by the daemon, not the webview.
- Microphone: grant the webview microphone access through the Tauri capability, nothing else from the media set.
- A shell-to-daemon secret passed via env at spawn (not argv, which other processes can read). The daemon's REST refuses requests without it. This closes the gap where any local process could drive the board through REST. **Done** (`docs/SECURITY.md` → Shell secret; tests in `daemon/test/server.test.ts`).
- Windows installer via the Tauri bundler. First run detects missing Node 24 and shows a dialog with the download link instead of failing silently.
- `docs/SECURITY.md` updated with the final threat model: what a malicious agent inside a worktree can and cannot reach.
- Investigate and document (implement only if trivial) Node single-executable builds for shipping the daemon as a real sidecar binary.
- Log entry `docs/handoffs/log/07-tauri-hardening.md`.

## Acceptance criteria
1. A script run from another terminal cannot call the daemon's REST without the shell secret.
2. Closing the window, killing the shell process, or logging off leaves no `node` daemon behind.
3. Installer installs and launches on a clean Windows user account with Node 24 present.
4. Navigating the webview to any external origin is blocked.

## Required tests
- REST without the shell secret → 401. With a stale secret after restart → 401.
- Simulated daemon crash → one restart → second crash → error dialog, no loop.
- Capability allowlist: calling an unlisted Tauri command from the webview fails.
