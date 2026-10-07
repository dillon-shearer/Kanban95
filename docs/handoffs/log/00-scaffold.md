# 00 — Scaffold (done 2026-10-07)

## What was built

- Root npm workspace (`package.json`, workspace `daemon`), `.gitignore`, `.npmrc` (`engine-strict=true`), `.node-version` (24), `README.md`.
- `daemon/src/server.ts`: `node:http` server on `127.0.0.1:0`, static `ui/` serving with traversal guard and MIME allowlist, `GET /health` → `{ok:true}`, CSP + nosniff headers on every response, `KANBAN95 port=<n>` handshake on stdout, exit on stdin EOF. `validateConfig` rejects any host other than `127.0.0.1`.
- `daemon/test/server.test.ts` (vitest, 8 tests): bind-host rejection for `0.0.0.0`, `::`, `::1`, `localhost`, a LAN IP; spawned-process handshake + `/health` + exit-on-stdin-close + port no longer answering; static serving refuses `..`, `%5c`, `%2e%2e` and files outside `ui/`; non-GET → 405.
- `ui/`: `index.html` (one 98.css window titled Kanban95), `app.js` (fetches `/health`, writes "daemon ok"), `app.css`. `ui/vendor/`: 98.css **0.1.21** (`98.css`, `ms_sans_serif.woff2`, `ms_sans_serif_bold.woff2`) from npm, no CDN.
- `shell/`: Tauri 2 project with no frontend assets and no declared windows. `src/main.rs` spawns `node <repo>/daemon/dist/server.js` with piped stdin/stdout, reads the handshake line, opens `WebviewWindow` "main" on `http://127.0.0.1:<port>/`, drains the rest of daemon stdout to stderr as `[daemon] …`, and on `RunEvent::Exit` kills and waits the child. `icons/icon.ico` is a generated 32x32 navy square (tauri-build on Windows refuses to build without one).
- `docs/ARCHITECTURE.md`: shell → daemon → UI, handshake, the two daemon-lifetime belts, network boundary.

## Deviations from the handoff

- **`npm run dev` uses `cargo run --manifest-path shell/Cargo.toml`, not `tauri dev`.** There is no npm `@tauri-apps/cli` dependency yet. With no `devUrl`/`frontendDist` the CLI adds nothing in dev; phase 7 adds it for bundling.
- **CSP lives in the daemon, not `tauri.conf.json`.** Tauri injects its configured CSP only into pages it serves over its own protocol. This app's window is an external URL on the daemon, so `app.security.csp` would do nothing. The daemon sends `default-src 'self'; img-src 'self' data:` (the `data:` is needed for 98.css's inline SVG icons). Covered by a test assertion on the header.
- **The bind host is not operator-configurable at all.** `validateConfig({host})` exists and rejects non-loopback (tested), but nothing reads a host from env or file; there is no config file until phase 1. Port can be fixed with `KANBAN95_PORT` for debugging only.
- **No Tauri capabilities dir.** The window is `WebviewUrl::External`, so it gets no IPC and needs no capability. Phase 7 revisits when/if IPC is used.

## Versions used

- Node **24.21.0** via fnm (machine default was 22.14, now `fnm default 24`; system `node` on PATH is still 22, see gotchas). npm 11.19.
- TypeScript **7.0.2**, vitest **5.0.3**, @types/node 26.6.4.
- Rust **1.99.0** (rustup 1.29.1, stable-x86_64-pc-windows-msvc, minimal profile). Visual Studio 2022 Build Tools with `Microsoft.VisualStudio.Workload.VCTools`, MSVC 14.44.35207. Installed via winget for VS Build Tools; `winget install Rustlang.Rustup` failed with `STATUS_CONTROL_C_EXIT`, so rustup-init.exe was downloaded and run directly with `-y --default-toolchain stable --profile minimal`.
- Tauri crates: `tauri` **2.12.1**, `tauri-build` **2.7.1** (`shell/Cargo.lock`, resolved 2026-10-07). WebView2 runtime 154.0.4258.62.

## Commands

```
npm install          # fails fast on Node < 24 (engine-strict)
npm run build        # tsc → daemon/dist
npm test             # tsc && vitest run (8 tests, ~0.6 s)
npm run dev          # build, then cargo run shell → spawns daemon → opens window
```

First `cargo build` of the shell: 1m48s. Incremental: ~10 s.

## Verified on Windows 11

1. `npm install && npm run build && npm test` passes under Node 24.
2. `npm run dev` (and the built exe alone) opens the Tauri window; the webview shows the 98.css window with "daemon ok". Daemon child listens on `127.0.0.1` only; `/health` answers with the CSP header.
3. `CloseMainWindow()` on the shell → shell exits 0, the daemon pid is gone, no stray `node`.
4. Non-loopback hosts rejected by `validateConfig` (tests).

## Gotchas for the next phase

- **`node` on PATH is still 22.** fnm is installed but not hooked into any shell profile (there is no `$PROFILE`). `import.meta.main` is `undefined` on 22, so the daemon prints nothing and the shell panics with `bad daemon handshake ""`. Either run `fnm env --use-on-cd | Out-String | Invoke-Expression` in the shell first, or prefix PATH with `%APPDATA%\fnm\node-versions\v24.21.0\installation`. The shell spawns `node` from *its* PATH, inherited from whoever ran `npm run dev`.
- **Daemon started with closed stdin exits immediately** after printing the port. That is the orphan guard working. Spawn it with `stdio: ['pipe', …]` and keep the pipe open.
- **Shell stdout is consumed by the handshake.** Anything the daemon prints before the port line breaks the shell. Keep the first stdout line sacred; log to stderr.
- **Debug shell is a console app.** `node` inherits that console. In release (`windows_subsystem = "windows"`) `node` will flash its own console unless spawned with `CREATE_NO_WINDOW`. Phase 7.
- `shell/gen/` is generated by tauri-build and gitignored. `shell/Cargo.lock` is committed.
- The bash tool here mis-resolved `export PATH="C:/..."`; use `/c/...` form.
- `cargo` is on the user PATH (`%USERPROFILE%\.cargo\bin`); new terminals pick it up, old ones need a restart.
- Repo was `git init`ed in this phase; nothing committed.
