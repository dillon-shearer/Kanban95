# 07 — Tauri hardening and packaging (done 2026-10-08)

Built by the board itself, in five tickets: shell secret, webview lock-down, daemon supervision, installer, this threat model.

## What was built

- **Shell secret** (`shell/src/main.rs` `mint_secret`, `daemon/src/server.ts`). 32 OS-random bytes per start, passed in `KANBAN95_SECRET` (env, never argv). The daemon deletes it from its own env at once and refuses to start without one. The window opens on `/?k95=<secret>`, which the daemon swaps for an `HttpOnly; SameSite=Strict` cookie and a `302 /`. `/api/*`, `/events` and `/pty/*` answer `401` without it; a secret from an earlier start gets `401` too. Tests in `daemon/test/server.test.ts` → shell secret.
- **Webview lock-down** (`shell/src/main.rs` `window`). No `capabilities/` dir, so every Tauri command is refused for the remote-URL window. `on_navigation` cancels anything off `http://127.0.0.1:<live port>`. `on_permission_request` allows the microphone and denies the rest, with no prompt. The CSP is the daemon's header (`frame-ancestors 'none'` added); `tauri.conf.json` keeps `csp: null` because Tauri's CSP only covers pages Tauri serves itself. `cargo test` in `shell/` covers the ACL refusal and the navigation lock.
- **Daemon supervision** (`supervise`, `kill_children_with_us`). A kill-on-close job object takes the daemon and `msedgewebview2.exe` down on every exit path. The daemon is restarted once with a fresh secret and port, and the navigation lock moves to the new port before the window navigates there. A second death, or a failed restart, gives a native error dialog and the board exits. `RunEvent::Exit` kills the child too. Unit tests use stand-in daemons that crash straight away.
- **Installer** (`npm run installer`, `shell/stage.mjs`, `shell/tauri.bundle.json`). This is a per-user NSIS installer that bundles the built daemon, production `node_modules`, `ui/` and `templates/` as `app/` next to the exe. Before spawning anything the shell checks `node --version`. When Node is missing or older than 24 it shows a Yes/No dialog that opens the download page. Node SEA was investigated and not implemented. The write-up and the cheaper upgrade path (ship `node.exe` as `externalBin`) are in `docs/ARCHITECTURE.md` → Packaging.
- **Agent guard**: every agent pty gets `KANBAN95_AGENT=1`. With it set, `npm run dev` and `Kanban95.cmd` refuse to start, and `daemon/test/cdp.ts` refuses to start a headed browser. This stops agents from opening windows on the operator's desktop by accident.
- **Threat model**: `docs/SECURITY.md` → A malicious agent in a worktree. It has two parts: a table of what a hostile worker or tester cannot reach, each row naming the code and the test that enforce it, and a list of what it can still reach as the operator's own user.

## Deviations from the handoff

- **No capability at all**, instead of "only the commands the UI calls": the UI calls none.
- **Microphone permission is granted in code** (`on_permission_request`), not through a Tauri capability. The random port means a new origin on every start, so a capability-scoped or prompted grant would ask again each time.
- **The secret reaches the page as a cookie, not a header.** The cookie swap left the UI code unchanged and keeps the secret away from page scripts.
- **A restart moves the window to a new origin**, so `localStorage` (window positions) starts empty after a daemon crash. Reusing the port was not worth the race.
- **The installer needs Node 24 on PATH**; Node is not bundled (see Packaging).
- **Acceptance 3 (installer on a clean Windows account) was not run by an agent.** NSIS closes running Kanban95 processes, and the operator's board was live. The staged daemon was verified to start from the installed layout, and the missing-Node dialog was seen with `PATH` set to System32 only. Installing on a clean account is left to the operator.
- **"Logging off leaves no node behind"** rests on the job object. Killing the shell with `taskkill /F` was checked live. Logoff was not exercised.

## Gotchas for the next phase

- The threat model is honest about the ceiling. Workers and testers run with permissions off as the operator's user, so they can open `board.db`, read another live Claude session's `mcp.json` and use the network. The upgrade is a separate low-privilege account or AppContainer. If phase 8 documents agent capabilities, do not describe the worktree as a sandbox.
- Probing a second shell while the operator's board runs: set `WEBVIEW2_USER_DATA_FOLDER` to a scratch dir, find your processes by walking `ParentProcessId` from your shell's pid, and kill only those. Never kill by name. `taskkill /F /PID <shell>` without `/T` is enough because of the job object.
- Do not rebuild or run the installer while the operator's board is live: a rebuild replaces `daemon/dist` under the running daemon, and NSIS closes the app.
- `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…` still works on a release build. A same-user process can set it, which falls under the same-user ceiling, not a new hole.
- A merge that touches `daemon/` or `shell/` needs a board restart to take effect (`Kanban95.cmd` rebuilds); `ui/` changes show at once.

## How to run and test

```
npm test                                    # daemon suite (vitest, headless Edge/Chrome); flaky under load, rerun a failing file alone
cargo test --manifest-path shell/Cargo.toml # supervisor, Node check, navigation lock, Tauri ACL refusal
npm run installer                           # shell/target/release/bundle/nsis/Kanban95_<version>_x64-setup.exe
Kanban95.cmd [repo]                         # developer entry point: builds, then starts the shell
```
