// Kanban95 shell: spawns the daemon, reads its port, opens one window on it, kills it on exit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Daemon(Mutex<Child>);

/// Starts `node daemon/dist/server.js` and returns the child plus the port from its first stdout line.
/// The child's stdin stays piped and open for as long as this process lives: the daemon exits on stdin EOF,
/// so even if we crash without reaching `kill`, it cannot be orphaned.
fn spawn_daemon() -> (Child, u16) {
    // ponytail: dev mode runs `node` from PATH against the built daemon. Phase 7 bundles Node as a real sidecar.
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../daemon/dist/server.js");
    let mut child = Command::new("node")
        .arg(script)
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
            panic!("bad daemon handshake {first:?} (expected `KANBAN95 port=<n>`; the daemon needs Node 24+)")
        });
    // Drain the rest so the daemon never blocks on a full stdout pipe.
    std::thread::spawn(move || {
        for line in lines.map_while(Result::ok) {
            eprintln!("[daemon] {line}");
        }
    });
    (child, port)
}

fn main() {
    let (child, port) = spawn_daemon();
    let url = format!("http://127.0.0.1:{port}/").parse().expect("daemon url");

    tauri::Builder::default()
        .manage(Daemon(Mutex::new(child)))
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Kanban95")
                .inner_size(1024.0, 720.0)
                .build()?;
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
