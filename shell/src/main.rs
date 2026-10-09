// Kanban95 shell: spawns the daemon, reads its port, opens one window on it, restarts the daemon once if it dies,
// shows an error dialog when it cannot run, and takes the daemon and WebView2 down with it on every exit path.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, RunEvent, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const NODE_DOWNLOAD: &str = "https://nodejs.org/en/download";

/// The live daemon. `None` once the shell is exiting, which tells the supervisor to stop.
struct Daemon(Mutex<Option<Child>>);

/// Says what is wrong with the Node on PATH, given the output of `node --version` (`None`: not found).
fn node_problem(version: Option<&str>) -> Option<String> {
    let Some(v) = version else {
        return Some(format!("Node.js was not found on PATH.\n\nKanban95 needs Node 24 or newer: {NODE_DOWNLOAD}"));
    };
    let v = v.trim();
    let major: u32 = v.trim_start_matches('v').split('.').next()?.parse().unwrap_or(0);
    (major < 24).then(|| format!("Kanban95 needs Node 24 or newer; the Node on PATH is {v}.\n\nDownload it: {NODE_DOWNLOAD}"))
}

fn check_node() -> Result<(), String> {
    let out = Command::new("node").arg("--version").stdin(Stdio::null()).output().ok();
    let version = out.filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    node_problem(version.as_deref()).map_or(Ok(()), Err)
}

/// 32 random bytes from the OS, hex: the shell-to-daemon secret for this run (docs/SECURITY.md).
fn mint_secret() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("OS random source");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The daemon the installer staged next to this exe (`app/`, shell/stage.mjs), else the repo's build (dev).
fn daemon_script() -> std::path::PathBuf {
    let installed = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.join("app/daemon/dist/server.js")));
    installed.filter(|p| p.is_file()).unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/../daemon/dist/server.js").into())
}

/// Starts `node daemon/dist/server.js` and returns the child plus the port from its first stdout line.
/// The child's stdin stays piped and open for as long as this process lives: the daemon exits on stdin EOF.
/// The secret goes in the child's environment, never on its command line, which other processes can read.
fn spawn_daemon(secret: &str) -> Result<(Child, u16), String> {
    // ponytail: runs `node` from PATH; shipping Node itself is open (docs/ARCHITECTURE.md -> Packaging).
    // The shell's first argument, if any, is the repo the board works on; the daemon defaults to the cwd.
    let mut child = Command::new("node")
        .arg(daemon_script())
        .args(std::env::args().nth(1))
        .env("KANBAN95_SECRET", secret)
        .env("KANBAN95_SHELL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Node.js: {e}.\n\nKanban95 needs Node 24 or newer: {NODE_DOWNLOAD}"))?;

    let mut lines = BufReader::new(child.stdout.take().expect("daemon stdout")).lines();
    let first = lines.next().and_then(Result::ok).unwrap_or_default();
    let Some(port) = first.strip_prefix("KANBAN95 port=").and_then(|p| p.trim().parse().ok()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "The Kanban95 daemon did not start (it said {first:?}).\n\nRun `npm run build` and check the console for the daemon's error."
        ));
    };
    // Drain the rest so the daemon never blocks on a full stdout pipe.
    std::thread::spawn(move || {
        for line in lines.map_while(Result::ok) {
            eprintln!("[daemon] {line}");
        }
    });
    Ok((child, port))
}

/// The daemon's exit code for Start -> Restart board (daemon/src/api.ts): restart it, it did not crash.
const RESTART_REQUESTED: i32 = 75;

/// Watches the daemon in `slot`. Exit code 75 always calls `restart`. The first other exit also calls it; the second
/// other exit, or any failed restart, returns the reason to show the operator. Returns `None` when the shell empties
/// the slot to exit.
fn supervise(slot: &Mutex<Option<Child>>, mut restart: impl FnMut() -> Result<Child, String>) -> Option<String> {
    let mut restarted = false;
    loop {
        // ponytail: 250 ms poll so `Exit` can take the child without waiting on a blocked `wait()`.
        std::thread::sleep(Duration::from_millis(250));
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(child) = guard.as_mut() else { return None };
        let Ok(Some(status)) = child.try_wait() else { continue };
        if status.code() == Some(RESTART_REQUESTED) {
            eprintln!("[shell] daemon asked to be restarted");
            match restart() {
                Ok(c) => *guard = Some(c),
                Err(e) => return Some(e),
            }
            continue;
        }
        if restarted {
            return Some(format!("The Kanban95 daemon stopped again ({status}) after one restart.\n\nThe board will close."));
        }
        restarted = true;
        eprintln!("[shell] daemon stopped ({status}); restarting it once");
        match restart() {
            Ok(c) => *guard = Some(c),
            Err(e) => return Some(e),
        }
    }
}

/// Native Windows error box: works before any window exists and while the webview is dead.
#[cfg(windows)]
fn error_dialog(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    // SAFETY: both strings are NUL-terminated and outlive the call; a null owner window is allowed.
    unsafe { MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide("Kanban95").as_ptr(), MB_OK | MB_ICONERROR | MB_SETFOREGROUND) };
}
#[cfg(not(windows))]
fn error_dialog(text: &str) {
    eprintln!("Kanban95: {text}");
}

/// Puts this process in a job that kills every member when its last handle closes. Children (node, msedgewebview2)
/// inherit the job, and the handle is only closed by this process dying, so window close, a crash, `taskkill /f`
/// and logoff all take the whole tree down.
#[cfg(windows)]
fn kill_children_with_us() {
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: plain Win32 calls on a zeroed, correctly sized struct; the job handle is leaked on purpose.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of_val(&info) as u32;
        let ok = !job.is_null()
            && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as _, size) != 0
            && AssignProcessToJobObject(job, GetCurrentProcess()) != 0;
        if !ok {
            eprintln!("[shell] could not set up the kill-on-close job: {}", std::io::Error::last_os_error());
        }
    }
}
#[cfg(not(windows))]
fn kill_children_with_us() {}

/// The daemon swaps `?k95=` for an HttpOnly cookie and redirects to `/`, so the page never holds the secret.
fn url(port: u16, secret: &str) -> Url {
    format!("http://127.0.0.1:{port}/?k95={secret}").parse().expect("daemon url")
}

/// Whether `to` is on the daemon's origin, `http://127.0.0.1:<port>`.
fn on_daemon(to: &Url, port: u16) -> bool {
    to.scheme() == "http" && to.host_str() == Some("127.0.0.1") && to.port() == Some(port)
}

/// "<repo folder> — Kanban95", as the UI titles itself, so the taskbar tells boards apart before the page loads.
/// Tauri 2 does not copy `document.title` to the window. The repo is the shell's first argument, else the cwd, as for the daemon.
fn title(repo: Option<String>) -> String {
    let dir = std::fs::canonicalize(repo.unwrap_or_else(|| ".".into())).ok();
    match dir.as_deref().and_then(std::path::Path::file_name) {
        Some(name) => format!("{} — Kanban95", name.to_string_lossy()),
        None => "Kanban95".into(),
    }
}

/// The board's only window, locked to the daemon's origin. It holds no Tauri capability (there is no `capabilities/`
/// dir), so every IPC command is refused for it: the UI talks to the daemon over HTTP and never calls Tauri.
fn window<R: Runtime, M: Manager<R>>(app: &M, url: Url, live: Arc<AtomicU16>) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title(title(std::env::args().nth(1)))
        .inner_size(1280.0, 720.0)
        // Any top-level navigation off the live daemon's origin (`http://127.0.0.1:<live port>`) is cancelled. New
        // windows are already refused by wry when no handler is set, and the CSP keeps frames and fetches on the origin.
        .on_navigation(move |to| on_daemon(to, live.load(Ordering::SeqCst)))
        // Navigation is pinned to the daemon's origin, so every request here comes from it. Answering in code
        // means no prompt, though the random port gives a new origin each start. Everything but the mic is denied.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Deny,
        })
        .build()
}

/// A missing or old Node is the one first-run problem the operator fixes outside the board, so offer the page.
#[cfg(windows)]
fn node_dialog(text: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let text = format!("{text}\n\nOpen the download page now?");
    // SAFETY: as in error_dialog; ShellExecuteW gets NUL-terminated strings that outlive the call.
    unsafe {
        let style = MB_YESNO | MB_ICONERROR | MB_SETFOREGROUND;
        if MessageBoxW(std::ptr::null_mut(), wide(&text).as_ptr(), wide("Kanban95").as_ptr(), style) == IDYES {
            let (op, url) = (wide("open"), wide(NODE_DOWNLOAD));
            ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), url.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
        }
    }
}
#[cfg(not(windows))]
fn node_dialog(text: &str) {
    error_dialog(text);
}

fn main() {
    kill_children_with_us();
    if let Err(e) = check_node() {
        node_dialog(&e);
        std::process::exit(1);
    }
    let secret = mint_secret();
    let (child, port) = match spawn_daemon(&secret) {
        Ok(started) => started,
        Err(e) => {
            error_dialog(&e);
            std::process::exit(1);
        }
    };
    // The port the window may be on. A restarted daemon has a new one, and the navigation lock follows it.
    let live = Arc::new(AtomicU16::new(port));

    tauri::Builder::default()
        .manage(Daemon(Mutex::new(Some(child))))
        .setup(move |app| {
            window(app, url(port, &secret), live.clone())?;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                let restart = || {
                    // A secret dies with its daemon (docs/SECURITY.md), so the new one gets its own.
                    let secret = mint_secret();
                    let (child, port) = spawn_daemon(&secret)?;
                    live.store(port, Ordering::SeqCst); // before navigating, or the lock cancels the move
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.navigate(url(port, &secret));
                    }
                    Ok(child)
                };
                if let Some(e) = supervise(&app.state::<Daemon>().0, restart) {
                    error_dialog(&e);
                    app.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri build")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let taken = app.state::<Daemon>().0.lock().ok().and_then(|mut g| g.take());
                if let Some(mut child) = taken {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    /// A stand-in daemon that crashes at once.
    fn crashing() -> Child {
        Command::new("cmd").args(["/c", "exit", "3"]).spawn().unwrap()
    }

    #[test]
    fn restarts_a_crashed_daemon_once_then_gives_up() {
        let slot = Mutex::new(Some(crashing()));
        let mut restarts = 0;
        let reason = supervise(&slot, || {
            restarts += 1;
            Ok(crashing())
        });
        assert_eq!(restarts, 1);
        assert!(reason.unwrap().contains("stopped again"));
    }

    /// A stand-in daemon that exits 75, as after Start -> Restart board.
    fn restart_requested() -> Child {
        Command::new("cmd").args(["/c", "exit", "75"]).spawn().unwrap()
    }

    #[test]
    fn a_requested_restart_does_not_spend_the_crash_budget() {
        let slot = Mutex::new(Some(restart_requested()));
        let mut restarts = 0;
        let reason = supervise(&slot, || {
            restarts += 1;
            // Three requested restarts, then a crash that is restarted once, then a second crash that gives up.
            Ok(if restarts < 3 { restart_requested() } else { crashing() })
        });
        assert_eq!(restarts, 4);
        assert!(reason.unwrap().contains("stopped again"));
    }

    #[test]
    fn a_failed_restart_is_reported_not_retried() {
        let slot = Mutex::new(Some(crashing()));
        let mut restarts = 0;
        let reason = supervise(&slot, || {
            restarts += 1;
            Err("no node".into())
        });
        assert_eq!((restarts, reason.as_deref()), (1, Some("no node")));
    }

    #[test]
    fn stops_quietly_when_the_shell_takes_the_daemon() {
        let slot = Mutex::new(None);
        assert_eq!(supervise(&slot, || panic!("must not restart")), None);
    }

    #[test]
    fn node_older_than_24_or_missing_is_named_with_the_download_link() {
        assert_eq!(node_problem(Some("v24.0.0\n")), None);
        assert_eq!(node_problem(Some("v25.1.2")), None);
        let old = node_problem(Some("v23.11.0\r\n")).unwrap();
        assert!(old.contains("v23.11.0") && old.contains(NODE_DOWNLOAD), "{old}");
        assert!(node_problem(Some("garbage")).unwrap().contains(NODE_DOWNLOAD));
        assert!(node_problem(None).unwrap().contains("not found"));
    }


    #[test]
    fn the_navigation_lock_follows_a_restarted_daemon_to_its_new_port() {
        let live = AtomicU16::new(41234);
        let at = |u: &str| on_daemon(&u.parse().unwrap(), live.load(Ordering::SeqCst));
        assert!(at("http://127.0.0.1:41234/?k95=x"));
        assert!(!at("http://127.0.0.1:41235/") && !at("http://localhost:41234/") && !at("https://127.0.0.1:41234/"));
        live.store(41235, Ordering::SeqCst); // what the restart does before it navigates
        assert!(at("http://127.0.0.1:41235/?k95=y"));
        assert!(!at("http://127.0.0.1:41234/"));
    }

    #[test]
    fn the_window_is_titled_after_the_repo_folder() {
        let dir = std::env::temp_dir().join("k95-title-repo");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(title(Some(format!("{}/", dir.display()))), "k95-title-repo — Kanban95"); // a trailing slash too
        std::fs::remove_dir(&dir).unwrap();
        assert_eq!(title(Some(dir.display().to_string())), "Kanban95"); // gone: no name to show
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(title(None), format!("{} — Kanban95", cwd.file_name().unwrap().to_string_lossy()));
    }

    /// The UI calls no Tauri command, so none may answer it: core plugin commands and unknown names alike.
    #[test]
    fn webview_cannot_call_any_tauri_command() {
        let app = mock_builder().build(tauri::generate_context!()).unwrap();
        let origin: tauri::Url = "http://127.0.0.1:41234/".parse().unwrap();
        let w = window(&app, origin.clone(), Arc::new(AtomicU16::new(41234))).unwrap();
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
