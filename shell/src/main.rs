// Kanban95 shell: spawns the daemon, reads its port, opens one window on it, restarts the daemon once if it dies,
// shows an error dialog when it cannot run, and takes the daemon and WebView2 down with it on every exit path.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

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

/// Starts `node daemon/dist/server.js` and returns the child plus the port from its first stdout line.
/// The child's stdin stays piped and open for as long as this process lives: the daemon exits on stdin EOF.
fn spawn_daemon() -> Result<(Child, u16), String> {
    // ponytail: dev mode runs `node` from PATH against the built daemon. Bundling Node as a sidecar is still open.
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../daemon/dist/server.js");
    // The shell's first argument, if any, is the repo the board works on; the daemon defaults to the cwd.
    let mut child = Command::new("node")
        .arg(script)
        .args(std::env::args().nth(1))
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

/// Watches the daemon in `slot`. The first unexpected exit calls `restart` for a replacement; the second exit, or a
/// failed restart, returns the reason to show the operator. Returns `None` when the shell empties the slot to exit.
fn supervise(slot: &Mutex<Option<Child>>, mut restart: impl FnMut() -> Result<Child, String>) -> Option<String> {
    let mut restarted = false;
    loop {
        // ponytail: 250 ms poll so `Exit` can take the child without waiting on a blocked `wait()`.
        std::thread::sleep(Duration::from_millis(250));
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(child) = guard.as_mut() else { return None };
        let Ok(Some(status)) = child.try_wait() else { continue };
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

fn url(port: u16) -> tauri::Url {
    format!("http://127.0.0.1:{port}/").parse().expect("daemon url")
}

fn main() {
    kill_children_with_us();
    let (child, port) = match check_node().and_then(|_| spawn_daemon()) {
        Ok(started) => started,
        Err(e) => {
            error_dialog(&e);
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .manage(Daemon(Mutex::new(Some(child))))
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url(port)))
                .title("Kanban95")
                .inner_size(1280.0, 720.0)
                .build()?;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                let restart = || {
                    let (child, port) = spawn_daemon()?;
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.navigate(url(port));
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
}
