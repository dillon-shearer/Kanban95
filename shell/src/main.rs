// Kanban95 shell: spawns the daemon, reads its port, opens one window on it, kills it on exit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, RunEvent, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

struct Daemon(Mutex<Child>);

/// Starts `node daemon/dist/server.js` and returns the child plus the port from its first stdout line.
/// The child's stdin stays piped and open for as long as this process lives: the daemon exits on stdin EOF,
/// so even if we crash without reaching `kill`, it cannot be orphaned.
fn spawn_daemon() -> (Child, u16) {
    // ponytail: dev mode runs `node` from PATH against the built daemon. Phase 7 bundles Node as a real sidecar.
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../daemon/dist/server.js");
    // The shell's first argument, if any, is the repo the board works on; the daemon defaults to the cwd.
    let mut child = Command::new("node")
        .arg(script)
        .args(std::env::args().nth(1))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("failed to start `node`: is Node 24+ on PATH and has `npm run build` been run?");

    let mut lines = BufReader::new(child.stdout.take().expect("daemon stdout")).lines();
    let first = lines.next().and_then(Result::ok).unwrap_or_default();
    let port = first
        .strip_prefix("KANBAN95 port=")
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or_else(|| {
            let _ = child.kill();
            panic!("bad daemon handshake {first:?} (expected `KANBAN95 port=<n>`; the daemon needs Node 24+ on PATH; start the board with Kanban95.cmd)")
        });
    // Drain the rest so the daemon never blocks on a full stdout pipe.
    std::thread::spawn(move || {
        for line in lines.map_while(Result::ok) {
            eprintln!("[daemon] {line}");
        }
    });
    (child, port)
}

/// The board's only window, locked to the daemon's origin. It holds no Tauri capability (there is no `capabilities/`
/// dir), so every IPC command is refused for it: the UI talks to the daemon over HTTP and never calls Tauri.
fn window<R: Runtime, M: Manager<R>>(app: &M, url: Url) -> tauri::Result<WebviewWindow<R>> {
    let own = url.origin();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Kanban95")
        .inner_size(1280.0, 720.0)
        // Any top-level navigation off the daemon's origin is cancelled. New windows are already refused by wry
        // when no handler is set, and the CSP keeps frames and fetches on the origin.
        .on_navigation(move |to| to.origin() == own)
        // Navigation is pinned to the daemon's origin, so every request here comes from it. Answering in code
        // means no prompt, though the random port gives a new origin each start. Everything but the mic is denied.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Deny,
        })
        .build()
}

fn main() {
    let (child, port) = spawn_daemon();
    let url = format!("http://127.0.0.1:{port}/").parse().expect("daemon url");

    tauri::Builder::default()
        .manage(Daemon(Mutex::new(child)))
        .setup(move |app| {
            window(app, url)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri build")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Ok(mut child) = app.state::<Daemon>().0.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    /// The UI calls no Tauri command, so none may answer it: core plugin commands and unknown names alike.
    #[test]
    fn webview_cannot_call_any_tauri_command() {
        let app = mock_builder().build(tauri::generate_context!()).unwrap();
        let origin: tauri::Url = "http://127.0.0.1:41234/".parse().unwrap();
        let w = super::window(&app, origin.clone()).unwrap();
        for cmd in [
            "plugin:app|version",
            "plugin:window|close",
            "plugin:webview|create_webview_window",
            "plugin:event|emit",
            "plugin:path|resolve_directory",
            "spawn_daemon",
        ] {
            let err = get_ipc_response(
                &w,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: origin.clone(),
                    body: Default::default(),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
            .expect_err(cmd);
            assert!(err.to_string().contains("not allowed"), "{cmd}: {err}");
        }
    }
}
