// Kanban95 shell: hosts one daemon per open project, shows one in the main window and popped-out ones in their own
// windows, restarts a daemon once if it dies, shows an error dialog when one cannot run, and takes every daemon and
// WebView2 down with it on every exit path.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const NODE_DOWNLOAD: &str = "https://nodejs.org/en/download";

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

/// 32 random bytes from the OS, hex: the shell-to-daemon secret for one daemon run (docs/SECURITY.md).
fn mint_secret() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("OS random source");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The daemon the installer staged (`app/`, shell/stage.mjs): next to this exe on Windows, in the bundle's
/// `Contents/Resources` on macOS (the exe is in `Contents/MacOS`). Else the repo's build (dev).
fn daemon_script() -> std::path::PathBuf {
    let dir = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.to_path_buf()));
    let installed = dir.into_iter().flat_map(|d| [d.join("app"), d.join("../Resources/app")]).map(|a| a.join("daemon/dist/server.js")).find(|p| p.is_file());
    installed.unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/../daemon/dist/server.js").into())
}

#[cfg(any(target_os = "macos", test))]
fn merge_path(current: &str, login: &str) -> String {
    let mut parts: Vec<&str> = current.split(':').filter(|p| !p.is_empty()).collect();
    for p in login.split(':') {
        if !p.is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    }
    parts.join(":")
}

#[cfg(target_os = "macos")]
fn add_login_path() {
    use std::io::Read;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let Ok(mut child) = Command::new(shell)
        .args(["-ilc", r#"printf '\n%s' "$PATH""#])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let end = Instant::now() + Duration::from_secs(5);
    while let Ok(None) = child.try_wait() {
        if Instant::now() > end {
            eprintln!("[shell] the login shell did not print its PATH within 5 s; keeping the PATH this app got");
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut out = String::new();
    if child.stdout.take().is_some_and(|mut o| o.read_to_string(&mut out).is_ok()) {
        let login = out.lines().last().unwrap_or_default();
        std::env::set_var("PATH", merge_path(&std::env::var("PATH").unwrap_or_default(), login));
    }
}
#[cfg(not(target_os = "macos"))]
fn add_login_path() {}

/// `node daemon/dist/server.js <repo>`; no repo (`""`): the daemon picks the first project, or serves first-run setup.
fn node(repo: &str) -> Command {
    // ponytail: runs `node` from PATH; shipping Node itself is open (docs/ARCHITECTURE.md -> Packaging).
    let mut cmd = Command::new("node");
    cmd.arg(daemon_script());
    if !repo.is_empty() {
        cmd.arg(repo);
    }
    cmd
}

/// The canonical repo path a hosted daemon is keyed by, without Windows' `\\?\` prefix so it matches the daemon's
/// own spelling. A path that does not exist is kept as given.
fn key(repo: &str) -> String {
    let dir = std::fs::canonicalize(repo).map_or_else(|_| repo.to_string(), |d| d.to_string_lossy().into_owned());
    match dir.strip_prefix(r"\\?\") {
        Some(rest) if rest.starts_with(r"UNC\") => format!(r"\\{}", &rest[4..]),
        Some(rest) => rest.to_string(),
        None => dir,
    }
}

type Lines = std::io::Lines<BufReader<ChildStdout>>;

struct Started {
    child: Child,
    port: u16,
    secret: String,
    lines: Lines,
}

/// Spawns a daemon. Its stdin stays piped and open: the daemon exits on stdin EOF. The secret goes in the child's
/// environment, never on its command line, which other processes can read.
fn spawn(mut cmd: Command) -> Result<(Child, String, ChildStdout), String> {
    let secret = mint_secret();
    let mut child = cmd
        .env("KANBAN95_SECRET", &secret)
        .env("KANBAN95_SHELL", "1")
        .env("KANBAN95_SHELL_ID", std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Node.js: {e}.\n\nKanban95 needs Node 24 or newer: {NODE_DOWNLOAD}"))?;
    let out = child.stdout.take().expect("daemon stdout");
    Ok((child, secret, out))
}

const HANDSHAKE_WAIT: Duration = Duration::from_secs(60);

fn handshake(out: ChildStdout) -> Result<(u16, Lines), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(out).lines();
        let first = lines.next().and_then(Result::ok).unwrap_or_default();
        let _ = tx.send((first, lines));
    });
    let Ok((first, lines)) = rx.recv_timeout(HANDSHAKE_WAIT) else {
        return Err(format!("The Kanban95 daemon did not say its port within {HANDSHAKE_WAIT:?}.\n\nCheck the console for the daemon's error."));
    };
    match first.strip_prefix("KANBAN95 port=").and_then(|p| p.trim().parse().ok()) {
        Some(port) => Ok((port, lines)),
        None => Err(format!(
            "The Kanban95 daemon did not start (it said {first:?}).\n\nRun `npm run build` and check the console for the daemon's error."
        )),
    }
}

/// Starts a daemon and waits for its handshake; a daemon that fails it is killed.
fn start(cmd: Command) -> Result<Started, String> {
    let (mut child, secret, out) = spawn(cmd)?;
    match handshake(out) {
        Ok((port, lines)) => Ok(Started { child, port, secret, lines }),
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(e)
        }
    }
}

/// The daemon's exit code for Start -> Restart board (daemon/src/api.ts): restart it, it did not crash.
const RESTART_REQUESTED: i32 = 75;

/// How long a closed daemon gets to shut down after stdin EOF, as the daemon's own cap, before it is killed.
const STOP_WAIT: Duration = Duration::from_secs(15);

const MAIN: &str = "main";

/// A command a daemon prints on stdout after its port line (docs/ARCHITECTURE.md -> Hosted boards).
#[derive(Debug, PartialEq, Clone, Copy)]
enum Verb {
    Open,
    Switch,
    Popout,
    Dock,
    Close,
}

fn parse(line: &str) -> Option<(Verb, &str)> {
    let (verb, path) = line.strip_prefix("KANBAN95 ")?.split_once('=')?;
    let verb = match verb {
        "open" => Verb::Open,
        "switch" => Verb::Switch,
        "popout" => Verb::Popout,
        "dock" => Verb::Dock,
        "close" => Verb::Close,
        _ => return None,
    };
    (!path.is_empty()).then_some((verb, path))
}

/// What the host asks of the windows, applied by `apply` in the app and recorded in tests.
#[derive(Debug, PartialEq)]
enum Effect {
    Show { label: String, url: Url, title: String },
    Open { label: String, url: Url, title: String },
    Focus(String),
    Close(String),
    Error(String),
    Exit(i32),
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum Place {
    Docked,
    Own,
}

struct Board {
    child: Child,
    port: u16,
    secret: String,
    place: Place,
    crashed: bool,
    restarting: Option<u64>,
    pending: Option<Child>,
}

#[derive(Default)]
struct Table {
    boards: BTreeMap<String, Board>,
    main: String,
    opening: BTreeSet<String>,
    closing: Vec<(Child, Instant)>,
    done: bool,
    restarts: u64,
    failed: bool,
}

/// The ports the navigation lock allows: every hosted daemon's. Kept apart from the table so the lock, which runs on
/// the main thread, never waits on a daemon starting.
type Ports = Arc<Mutex<Vec<u16>>>;

/// The hosted daemons, keyed by canonical repo path. `done` once the shell is exiting: nothing new starts and the
/// supervisor stops.
struct Host {
    table: Mutex<Table>,
    ports: Ports,
    launch: Box<dyn Fn(&str) -> Command + Send + Sync>,
    ui: OnceLock<Box<dyn Fn(Effect) + Send + Sync>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A popped-out window's label, from the repo path.
fn label(repo: &str) -> String {
    format!("board-{}", fnv(repo))
}

fn show(label: &str, repo: &str, b: &Board) -> Effect {
    Effect::Show { label: label.into(), url: url(b.port, &b.secret, b.place), title: title(Some(repo.into())) }
}

impl Host {
    fn new(launch: impl Fn(&str) -> Command + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Host { table: Mutex::default(), ports: Ports::default(), launch: Box::new(launch), ui: OnceLock::new() })
    }

    fn start(&self, repo: &str) -> Result<Started, String> {
        start((self.launch)(repo))
    }

    fn emit(&self, fx: Vec<Effect>) {
        if let Some(ui) = self.ui.get() {
            fx.into_iter().for_each(ui);
        }
    }

    fn sync(&self, t: &Table) {
        *lock(&self.ports) = t.boards.values().map(|b| b.port).collect();
    }

    /// Reads the daemon's stdout to EOF, which also keeps the pipe from filling, and acts on its commands.
    fn board(self: &Arc<Self>, s: Started, place: Place, crashed: bool) -> Board {
        let host = self.clone();
        let lines = s.lines;
        std::thread::spawn(move || {
            for line in lines.map_while(Result::ok) {
                eprintln!("[daemon] {line}");
                if let Some((verb, path)) = parse(&line) {
                    host.command(verb, path);
                }
            }
        });
        Board { child: s.child, port: s.port, secret: s.secret, place, crashed, restarting: None, pending: None }
    }

    fn restart(self: &Arc<Self>, repo: String, gen: u64) {
        let (child, secret, out) = match spawn((self.launch)(&repo)) {
            Ok(s) => s,
            Err(e) => return self.restarted(&repo, gen, Err(e)),
        };
        let parked = {
            let mut t = lock(&self.table);
            match t.boards.get_mut(&repo).filter(|b| b.restarting == Some(gen)) {
                Some(b) => {
                    b.pending = Some(child);
                    None
                }
                None => Some(child),
            }
        };
        if let Some(mut child) = parked {
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
        let shake = handshake(out).map(|(port, lines)| (port, secret, lines));
        self.restarted(&repo, gen, shake);
    }

    fn restarted(self: &Arc<Self>, repo: &str, gen: u64, shake: Result<(u16, String, Lines), String>) {
        let mut fx = vec![];
        let mut t = lock(&self.table);
        let Some(old) = t.boards.get_mut(repo).filter(|b| b.restarting == Some(gen)) else {
            return;
        };
        let child = old.pending.take();
        match (shake, child) {
            (Ok((port, secret, lines)), Some(child)) => {
                let (place, crashed) = (old.place, old.crashed);
                let b = self.board(Started { child, port, secret, lines }, place, crashed);
                match place {
                    Place::Own => fx.push(show(&label(repo), repo, &b)),
                    Place::Docked if t.main == repo => fx.push(show(MAIN, repo, &b)),
                    Place::Docked => {}
                }
                t.boards.insert(repo.into(), b);
                self.sync(&t);
            }
            (shake, child) => {
                if let Some(mut c) = child {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                fx.push(Effect::Error(shake.err().unwrap_or_default()));
                self.remove(&mut t, repo, &mut fx);
                t.failed = true;
            }
        }
        drop(t);
        self.emit(fx);
    }

    fn first(self: &Arc<Self>, repo: &str, s: Started) {
        let mut t = lock(&self.table);
        let b = self.board(s, Place::Docked, false);
        t.boards.insert(repo.into(), b);
        t.main = repo.into();
        self.sync(&t);
    }

    fn command(self: &Arc<Self>, verb: Verb, path: &str) {
        let repo = key(path);
        let mut fx = vec![];
        let mut t = lock(&self.table);
        if t.done {
            return;
        }
        let place = t.boards.get(&repo).map(|b| b.place);
        match (verb, place) {
            (Verb::Open | Verb::Popout, Some(Place::Own)) => fx.push(Effect::Focus(label(&repo))),
            (Verb::Open | Verb::Switch, Some(Place::Docked)) => {
                fx.push(show(MAIN, &repo, &t.boards[&repo]));
                t.main = repo;
            }
            (Verb::Open, None) => {
                if t.opening.insert(repo.clone()) {
                    let host = self.clone();
                    std::thread::spawn(move || host.open(repo));
                }
            }
            (Verb::Popout, Some(Place::Docked)) => {
                if t.main == repo {
                    let Some(other) = t.boards.iter().find(|(r, b)| **r != repo && b.place == Place::Docked).map(|(r, _)| r.clone()) else {
                        eprintln!("[shell] {repo} is the only board in the main window; it stays there");
                        return;
                    };
                    fx.push(show(MAIN, &other, &t.boards[&other]));
                    t.main = other;
                }
                let b = t.boards.get_mut(&repo).expect("hosted");
                b.place = Place::Own;
                fx.push(Effect::Open { label: label(&repo), url: url(b.port, &b.secret, b.place), title: title(Some(repo.clone())) });
            }
            (Verb::Dock, Some(Place::Own)) => {
                let b = t.boards.get_mut(&repo).expect("hosted");
                b.place = Place::Docked;
                fx.push(Effect::Close(label(&repo)));
                fx.push(show(MAIN, &repo, b));
                t.main = repo;
            }
            (Verb::Close, Some(_)) => self.close(&mut t, &repo, &mut fx),
            (verb, _) => eprintln!("[shell] ignored {verb:?} for {repo}: not a board in that state"),
        }
        drop(t);
        self.emit(fx);
    }

    fn open(self: &Arc<Self>, repo: String) {
        let started = self.start(&repo);
        let mut fx = vec![];
        let mut t = lock(&self.table);
        t.opening.remove(&repo);
        match started {
            Ok(mut s) if t.done => {
                let _ = s.child.kill();
                let _ = s.child.wait();
            }
            Ok(s) => {
                let b = self.board(s, Place::Docked, false);
                fx.push(show(MAIN, &repo, &b));
                t.boards.insert(repo.clone(), b);
                t.main = repo;
                self.sync(&t);
            }
            Err(e) => fx.push(Effect::Error(e)),
        }
        drop(t);
        self.emit(fx);
    }

    /// Drops a board from the table, closes its own window, and moves the main window off it if it showed it.
    fn remove(&self, t: &mut Table, repo: &str, fx: &mut Vec<Effect>) -> Option<Board> {
        let b = t.boards.remove(repo)?;
        if b.place == Place::Own {
            fx.push(Effect::Close(label(repo)));
        }
        if t.main == repo {
            let next = t.boards.iter().find(|(_, b)| b.place == Place::Docked).or_else(|| t.boards.iter().next());
            if let Some(next) = next.map(|(r, _)| r.clone()) {
                let nb = t.boards.get_mut(&next).expect("hosted");
                if nb.place == Place::Own {
                    nb.place = Place::Docked;
                    fx.push(Effect::Close(label(&next)));
                }
                fx.push(show(MAIN, &next, nb));
                t.main = next;
            }
        }
        self.sync(t);
        Some(b)
    }

    /// Closes the daemon's stdin so it shuts down as on Stdin EOF; the supervisor kills it after `STOP_WAIT`.
    fn close(&self, t: &mut Table, repo: &str, fx: &mut Vec<Effect>) {
        if let Some(mut b) = self.remove(t, repo, fx) {
            drop(b.child.stdin.take());
            t.closing.push((b.child, Instant::now() + STOP_WAIT));
            if let Some(mut c) = b.pending {
                let _ = c.kill();
                t.closing.push((c, Instant::now()));
            }
        }
    }

    fn window_closed(&self, window: &str) {
        let mut fx = vec![];
        let mut t = lock(&self.table);
        if t.done {
            return;
        }
        let repo = t.boards.iter().find(|(r, b)| b.place == Place::Own && label(r) == window).map(|(r, _)| r.clone());
        if let Some(repo) = repo {
            t.boards.get_mut(&repo).expect("hosted").place = Place::Docked;
            self.close(&mut t, &repo, &mut fx);
        }
        drop(t);
        self.emit(fx);
    }

    /// One supervisor pass. Exit code 75 always restarts that daemon. Its first other exit also restarts it; the second
    /// other exit, or a failed restart, shows the reason and drops that daemon only. Returns false once the shell is
    /// done: on exit, or when no daemon is left, which also exits the app.
    fn tick(self: &Arc<Self>) -> bool {
        let mut fx = vec![];
        let mut t = lock(&self.table);
        if t.done {
            return false;
        }
        let now = Instant::now();
        t.closing.retain_mut(|(child, until)| match child.try_wait() {
            Ok(None) if now < *until => true,
            Ok(None) => {
                eprintln!("[shell] a closed daemon did not stop in {STOP_WAIT:?}; killing it");
                let _ = child.kill();
                let _ = child.wait();
                false
            }
            _ => false,
        });
        let exited: Vec<_> = t
            .boards
            .iter_mut()
            .filter(|(_, b)| b.restarting.is_none())
            .filter_map(|(r, b)| Some((r.clone(), b.child.try_wait().ok()??)))
            .collect();
        for (repo, status) in exited {
            let requested = status.code() == Some(RESTART_REQUESTED);
            let crashed = t.boards[&repo].crashed;
            if requested {
                eprintln!("[shell] {repo}: daemon asked to be restarted");
            } else if crashed {
                fx.push(Effect::Error(format!("The Kanban95 daemon for {repo} stopped again ({status}) after one restart.\n\nThat board will close.")));
                self.remove(&mut t, &repo, &mut fx);
                continue;
            } else {
                eprintln!("[shell] {repo}: daemon stopped ({status}); restarting it once");
            }
            // A secret dies with its daemon (docs/SECURITY.md), so the new one gets its own.
            t.restarts += 1;
            let gen = t.restarts;
            let b = t.boards.get_mut(&repo).expect("hosted");
            b.crashed = crashed || !requested;
            b.restarting = Some(gen);
            let host = self.clone();
            std::thread::spawn(move || host.restart(repo, gen));
        }
        self.sync(&t);
        let failed = std::mem::take(&mut t.failed);
        if t.boards.is_empty() && t.opening.is_empty() && t.closing.is_empty() {
            t.done = true;
            let failed = failed || fx.iter().any(|f| matches!(f, Effect::Error(_)));
            fx.push(Effect::Exit(if failed { 1 } else { 0 }));
        }
        let done = t.done;
        drop(t);
        self.emit(fx);
        !done
    }

    /// On exit: kills and waits on every daemon, hosted or closing, and stops the supervisor.
    fn shutdown(&self) {
        let mut t = lock(&self.table);
        t.done = true;
        let mut children: Vec<Child> = std::mem::take(&mut t.boards).into_values().flat_map(|b| [Some(b.child), b.pending]).flatten().collect();
        children.extend(std::mem::take(&mut t.closing).into_iter().map(|(c, _)| c));
        for c in &mut children {
            let _ = c.kill();
        }
        for c in &mut children {
            let _ = c.wait();
        }
        self.sync(&t);
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
fn url(port: u16, secret: &str, place: Place) -> Url {
    let own = if place == Place::Own { "#own" } else { "" };
    format!("http://127.0.0.1:{port}/?k95={secret}{own}").parse().expect("daemon url")
}

/// Whether `to` is on a hosted daemon's origin, `http://127.0.0.1:<port>`.
fn on_daemon(to: &Url, ports: &[u16]) -> bool {
    to.scheme() == "http" && to.host_str() == Some("127.0.0.1") && to.port().is_some_and(|p| ports.contains(&p))
}

/// "<repo folder> — Kanban95", as the UI titles itself, so the taskbar tells boards apart before the page loads.
/// Tauri 2 does not copy `document.title` to the window.
fn title(repo: Option<String>) -> String {
    let dir = std::fs::canonicalize(repo.unwrap_or_else(|| ".".into())).ok();
    match dir.as_deref().and_then(std::path::Path::file_name) {
        Some(name) => format!("{} — Kanban95", name.to_string_lossy()),
        None => "Kanban95".into(),
    }
}

/// FNV-1a, hex. Not `DefaultHasher`, because names built from it must stay the same across Rust releases.
fn fnv(s: &str) -> String {
    let hash = s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{hash:016x}")
}

/// The shell's WebView2 profile folder name: FNV-1a of the canonical path of the repo it started with (its first
/// argument, else the cwd). A profile has one `msedgewebview2.exe` browser process, started by the first shell to use
/// it and so held in that shell's kill-on-close job: a profile shared across shells would die with whichever started
/// first, blanking the rest. Every board this shell hosts shares it.
fn profile(repo: Option<String>) -> String {
    let repo = repo.unwrap_or_else(|| ".".into());
    fnv(&std::fs::canonicalize(&repo).map_or(repo, |d| d.to_string_lossy().into_owned()))
}

/// A board window, locked to the hosted daemons' origins. It holds no Tauri capability (there is no `capabilities/`
/// dir), so every IPC command is refused for it: the UI talks to the daemon over HTTP and never calls Tauri.
fn window<R: Runtime, M: Manager<R>>(app: &M, label: &str, url: Url, title: String, ports: Ports) -> tauri::Result<WebviewWindow<R>> {
    // WebView2 prefers `WEBVIEW2_USER_DATA_FOLDER` to the folder passed here; passing it too keeps Tauri from
    // creating an unused profile folder.
    let data = match std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        Some(dir) => dir.into(),
        None => app.path().app_local_data_dir()?.join("boards").join(profile(std::env::args().nth(1))),
    };
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .data_directory(data)
        .inner_size(1280.0, 720.0)
        // Any top-level navigation off a hosted daemon's origin is cancelled. New windows are already refused by wry
        // when no handler is set, and the CSP keeps frames and fetches on the origin.
        .on_navigation(move |to| on_daemon(to, &lock(&ports)))
        // Navigation is pinned to the daemons' origins, so every request here comes from one. Answering in code
        // means no prompt, though the random port gives a new origin each start. Everything but the mic is denied.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Deny,
        })
        .build()
}

/// The page's fullscreen (Start -> Full screen, F11) sets the window's, over the Windows taskbar. Tauri's own
/// ContainsFullScreenElementChanged handler, registered just before this one, would also follow the false a
/// navigation raises, so it is removed and this one is the only follower.
#[cfg(windows)]
fn follow_page_fullscreen<R: Runtime>(w: &WebviewWindow<R>) {
    use std::{cell::Cell, rc::Rc};
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, ContainsFullScreenElementChangedEventHandler,
        NavigationCompletedEventHandler, NavigationStartingEventHandler,
    };
    use windows_core::w;
    let win = w.clone();
    let _ = w.with_webview(move |wv| {
        // SAFETY: COM calls on the live controller, on the main thread where with_webview runs this.
        unsafe {
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let navigating = Rc::new(Cell::new(false));
            let (starting, changed) = (navigating.clone(), navigating.clone());
            let full_win = win.clone();
            let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |core, _| {
                let mut full = windows_core::BOOL::default();
                if let Some(core) = core {
                    core.ContainsFullScreenElement(&mut full)?;
                }
                if full.as_bool() || !changed.get() {
                    let _ = full_win.set_fullscreen(full.as_bool());
                }
                Ok(())
            }));
            let mut token = 0;
            if core.add_ContainsFullScreenElementChanged(&handler, &mut token).is_ok() {
                let _ = core.remove_ContainsFullScreenElementChanged(token - 1);
            }
            let handler = NavigationStartingEventHandler::create(Box::new(move |_, _| {
                starting.set(true);
                Ok(())
            }));
            let _ = core.add_NavigationStarting(&handler, &mut token);
            let handler = NavigationCompletedEventHandler::create(Box::new(move |core, _| {
                navigating.set(false);
                let Some(core) = core else { return Ok(()) };
                let mut full = windows_core::BOOL::default();
                core.ContainsFullScreenElement(&mut full)?;
                if !full.as_bool() && win.is_fullscreen().unwrap_or(false) {
                    let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                    core.CallDevToolsProtocolMethod(
                        w!("Runtime.evaluate"),
                        w!(r#"{"expression":"document.documentElement.requestFullscreen()","userGesture":true}"#),
                        &done,
                    )?;
                }
                Ok(())
            }));
            let _ = core.add_NavigationCompleted(&handler, &mut token);
        }
    });
}
#[cfg(not(windows))]
fn follow_page_fullscreen<R: Runtime>(_: &WebviewWindow<R>) {}

fn apply<R: Runtime>(app: &AppHandle<R>, ports: &Ports, fx: Effect) {
    match fx {
        Effect::Show { label, url, title } => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.set_title(&title);
                let _ = w.navigate(url);
            }
        }
        Effect::Open { label, url, title } => match window(app, &label, url, title, ports.clone()) {
            Ok(w) => follow_page_fullscreen(&w),
            Err(e) => eprintln!("[shell] could not open a window: {e}"),
        },
        Effect::Focus(label) => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        Effect::Close(label) => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.close();
            }
        }
        Effect::Error(e) => error_dialog(&e),
        Effect::Exit(code) => app.exit(code),
    }
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
    add_login_path();
    if let Err(e) = check_node() {
        node_dialog(&e);
        std::process::exit(1);
    }
    // The shell's first argument, if any, is the repo of its first board. Without one (Start menu, Dock) the daemon decides,
    // and the board is keyed "" (docs/ARCHITECTURE.md -> Startup without an argument).
    // ponytail: a board keyed "" that another board then opens by path gets a second daemon; re-keying on the handshake would fix it.
    let repo = std::env::args().nth(1).map(|a| key(&a)).unwrap_or_default();
    let host = Host::new(node);
    let first = match host.start(&repo) {
        Ok(started) => started,
        Err(e) => {
            error_dialog(&e);
            std::process::exit(1);
        }
    };
    let setup = host.clone();

    tauri::Builder::default()
        .manage(host)
        .setup(move |app| {
            let host = setup;
            let (handle, ports) = (app.handle().clone(), host.ports.clone());
            let _ = host.ui.set(Box::new(move |fx| apply(&handle, &ports, fx)));
            let main = url(first.port, &first.secret, Place::Docked);
            host.first(&repo, first);
            follow_page_fullscreen(&window(app, MAIN, main, title(Some(repo)), host.ports.clone())?);
            std::thread::spawn(move || {
                // ponytail: 250 ms poll so `Exit` can take every child without waiting on a blocked `wait()`.
                while host.tick() {
                    std::thread::sleep(Duration::from_millis(250));
                }
            });
            Ok(())
        })
        .on_window_event(|w, event| {
            if let WindowEvent::Destroyed = event {
                if w.label() == MAIN {
                    w.app_handle().exit(0);
                } else {
                    w.state::<Arc<Host>>().window_closed(w.label());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("tauri build")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<Arc<Host>>().shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    #[cfg(windows)]
    fn stand_in(line: String) -> Command {
        let mut c = Command::new("cmd");
        c.raw_arg(format!("/d /c {line}"));
        c
    }
    #[cfg(windows)]
    const THEN: &str = "&";
    #[cfg(windows)]
    const WAIT: &str = "findstr x";
    #[cfg(windows)]
    fn save_shell_id(file: &str) -> String {
        format!(">\"{file}\" echo %KANBAN95_SHELL_ID%{THEN}")
    }

    #[cfg(not(windows))]
    fn stand_in(line: String) -> Command {
        let mut c = Command::new("sh");
        c.args(["-c", &line]);
        c
    }
    #[cfg(not(windows))]
    const THEN: &str = ";";
    #[cfg(not(windows))]
    const WAIT: &str = "exec cat >/dev/null";
    #[cfg(not(windows))]
    fn save_shell_id(file: &str) -> String {
        format!("echo \"$KANBAN95_SHELL_ID\" >\"{file}\"{THEN}")
    }

    fn exits(port: u16, code: i32) -> String {
        format!("echo KANBAN95 port={port}{THEN}exit {code}")
    }

    /// A host whose daemons are `cmd` (Windows) or `sh` stand-ins: `script(repo, n)` is the n-th start's command line for
    /// that repo.
    fn host(script: impl Fn(&str, usize) -> String + Send + Sync + 'static) -> (Arc<Host>, Arc<Mutex<Vec<Effect>>>) {
        let starts = Mutex::new(BTreeMap::<String, usize>::new());
        let host = Host::new(move |repo| {
            let n = {
                let mut s = lock(&starts);
                let n = s.entry(repo.into()).or_default();
                *n += 1;
                *n
            };
            stand_in(script(repo, n))
        });
        let seen = Arc::new(Mutex::new(vec![]));
        let rec = seen.clone();
        let _ = host.ui.set(Box::new(move |fx| lock(&rec).push(fx)));
        (host, seen)
    }

    /// Prints the port line and `then` lines, then waits for stdin EOF.
    fn up(port: u16, then: &str) -> String {
        format!("echo KANBAN95 port={port}{THEN}{then}{WAIT}")
    }

    fn until(what: &str, mut ok: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(10);
        while !ok() {
            assert!(Instant::now() < end, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn shown(seen: &Mutex<Vec<Effect>>) -> Vec<(String, u16)> {
        lock(seen)
            .iter()
            .filter_map(|f| match f {
                Effect::Show { label, url, .. } => Some((label.clone(), url.port()?)),
                _ => None,
            })
            .collect()
    }

    fn pid(host: &Host, repo: &str) -> u32 {
        lock(&host.table).boards[repo].child.id()
    }

    #[cfg(windows)]
    fn alive(pid: u32) -> bool {
        let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!(" {pid} "))
    }
    #[cfg(not(windows))]
    fn alive(pid: u32) -> bool {
        Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().unwrap().success()
    }

    fn hosted(host: &Host) -> Vec<(String, Place)> {
        lock(&host.table).boards.iter().map(|(r, b)| (r.clone(), b.place)).collect()
    }

    #[test]
    fn parses_every_command_and_nothing_else() {
        assert_eq!(parse("KANBAN95 open=C:\\a b\\c"), Some((Verb::Open, "C:\\a b\\c")));
        assert_eq!(parse("KANBAN95 switch=x"), Some((Verb::Switch, "x")));
        assert_eq!(parse("KANBAN95 popout=x"), Some((Verb::Popout, "x")));
        assert_eq!(parse("KANBAN95 dock=x"), Some((Verb::Dock, "x")));
        assert_eq!(parse("KANBAN95 close=x=y"), Some((Verb::Close, "x=y")));
        for bad in ["KANBAN95 open=", "KANBAN95 port=41234", "KANBAN95 fly=x", "KANBAN95 open", "kanban95 open=x", " KANBAN95 open=x", "listening"] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn open_from_a_daemon_hosts_a_second_one_with_the_shell_id_and_shows_it() {
        let id_file = std::env::temp_dir().join(format!("k95-shell-id-{}", std::process::id()));
        let file = id_file.display().to_string();
        let (host, seen) = host(move |repo, _| match repo {
            "k95-a" => up(41001, &format!("echo KANBAN95 open=k95-b{THEN}echo KANBAN95 open=k95-b{THEN}")),
            _ => format!("{}{}", save_shell_id(&file), up(41002, "")),
        });
        host.first("k95-a", host.start("k95-a").unwrap());
        until("the second board", || shown(&seen).contains(&(MAIN.into(), 41002)));
        assert_eq!(std::fs::read_to_string(&id_file).unwrap().trim(), std::process::id().to_string());
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked), ("k95-b".into(), Place::Docked)]);
        assert_eq!(lock(&host.table).main, "k95-b");
        assert_eq!(*lock(&host.ports), [41001, 41002]);
        host.shutdown();
        std::fs::remove_file(&id_file).unwrap();
    }

    #[test]
    fn switch_popout_and_dock_move_boards_between_the_windows() {
        let (host, seen) = host(|repo, _| up(if repo == "k95-a" { 41001 } else { 41002 }, ""));
        host.first("k95-a", host.start("k95-a").unwrap());
        host.command(Verb::Open, "k95-b");
        until("the second board", || hosted(&host).len() == 2);
        let b_pid = pid(&host, "k95-b");
        let effects = |seen: &Mutex<Vec<Effect>>| std::mem::take(&mut *lock(seen));
        effects(&seen);

        host.command(Verb::Switch, "k95-a");
        assert_eq!(shown(&seen), [(MAIN.into(), 41001)]);
        effects(&seen);

        host.command(Verb::Popout, "k95-a");
        let fx = effects(&seen);
        assert!(matches!(&fx[..], [Effect::Show { label: main, .. }, Effect::Open { label: own, url, .. }] if main == MAIN && *own == label("k95-a") && url.port() == Some(41001) && url.fragment() == Some("own")), "{fx:?}");
        assert_eq!(lock(&host.table).main, "k95-b");

        host.command(Verb::Popout, "k95-b");
        assert!(effects(&seen).is_empty(), "the only docked board stays in the main window");
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Own), ("k95-b".into(), Place::Docked)]);

        host.command(Verb::Dock, "k95-a");
        let fx = effects(&seen);
        assert!(matches!(&fx[..], [Effect::Close(own), Effect::Show { label: main, url, .. }] if *own == label("k95-a") && main == MAIN && url.port() == Some(41001) && url.fragment().is_none()), "{fx:?}");
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked), ("k95-b".into(), Place::Docked)]);

        host.command(Verb::Popout, "k95-b");
        assert!(matches!(&effects(&seen)[..], [Effect::Open { .. }]));
        host.window_closed(&label("k95-b"));
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked)]);
        until("the popped-out board's daemon to stop", || {
            host.tick();
            !alive(b_pid)
        });
        assert!(effects(&seen).is_empty(), "the main window stays on its board");
        host.shutdown();
    }

    #[test]
    fn close_ends_the_last_daemon_through_stdin_eof_and_exits() {
        let (host, seen) = host(|_, _| up(41001, ""));
        host.first("k95-a", host.start("k95-a").unwrap());
        let a = pid(&host, "k95-a");
        let began = Instant::now();
        host.command(Verb::Close, "k95-a");
        until("the shell to finish", || !host.tick());
        assert!(began.elapsed() < Duration::from_secs(10), "stopped by EOF, not by the 15 s kill");
        assert!(!alive(a));
        assert_eq!(lock(&seen).last(), Some(&Effect::Exit(0)));
        assert!(lock(&host.table).closing.is_empty());
    }

    #[test]
    fn each_daemon_is_restarted_on_75_and_once_on_a_crash() {
        let (host, seen) = host(|repo, n| match (repo, n) {
            ("k95-a", _) => up(41001, ""),
            (_, 1) => exits(41002, 75),
            (_, 2) => exits(41003, 3),
            (_, 3) => exits(41004, 3),
            _ => panic!("restarted after the second crash"),
        });
        host.first("k95-a", host.start("k95-a").unwrap());
        let a = pid(&host, "k95-a");
        host.command(Verb::Open, "k95-b");
        until("the crashing board to be dropped", || {
            host.tick();
            lock(&seen).iter().any(|f| matches!(f, Effect::Error(_)))
        });
        let fx = lock(&seen);
        assert!(matches!(fx.iter().find(|f| matches!(f, Effect::Error(_))), Some(Effect::Error(e)) if e.contains("stopped again")));
        assert!(!fx.iter().any(|f| matches!(f, Effect::Exit(_))));
        drop(fx);
        let main = |p| (MAIN.to_string(), p);
        assert_eq!(shown(&seen), [main(41002), main(41003), main(41004), main(41001)]);
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked)]);
        assert_eq!(pid(&host, "k95-a"), a);
        assert!(host.tick());
        host.shutdown();
    }

    #[test]
    fn a_failed_restart_of_the_last_board_is_reported_and_exits() {
        let (host, seen) = host(|_, n| if n == 1 { exits(41001, 3) } else { "echo nope".into() });
        host.first("k95-a", host.start("k95-a").unwrap());
        until("the shell to finish", || !host.tick());
        let fx = lock(&seen);
        assert!(matches!(&fx[..], [Effect::Error(e), Effect::Exit(1)] if e.contains("nope")), "{fx:?}");
    }

    #[test]
    fn shutdown_kills_every_daemon_and_stops_the_supervisor() {
        let (host, _) = host(|repo, _| up(if repo == "k95-a" { 41001 } else { 41002 }, ""));
        host.first("k95-a", host.start("k95-a").unwrap());
        host.command(Verb::Open, "k95-b");
        until("the second board", || hosted(&host).len() == 2);
        let pids = [pid(&host, "k95-a"), pid(&host, "k95-b")];
        host.command(Verb::Popout, "k95-b");
        host.shutdown();
        assert!(pids.iter().all(|p| !alive(*p)));
        assert!(hosted(&host).is_empty() && lock(&host.ports).is_empty());
        assert!(!host.tick());
        host.command(Verb::Open, "k95-c");
        assert!(lock(&host.table).opening.is_empty(), "nothing starts once the shell is exiting");
    }

    fn stalled(host: &Host, repo: &str) -> Option<u32> {
        lock(&host.table).boards.get(repo)?.pending.as_ref().map(Child::id)
    }

    #[test]
    fn a_restart_that_never_handshakes_blocks_no_other_board_and_closing_it_cancels_it() {
        let (host, seen) = host(|repo, n| match (repo, n) {
            ("k95-a", _) => up(41001, ""),
            (_, 1) => exits(41002, 75),
            _ => WAIT.into(),
        });
        host.first("k95-a", host.start("k95-a").unwrap());
        host.command(Verb::Open, "k95-b");
        until("the stalled restart", || {
            host.tick();
            stalled(&host, "k95-b").is_some()
        });
        let p = stalled(&host, "k95-b").unwrap();
        let began = Instant::now();
        assert!(host.tick());
        host.command(Verb::Switch, "k95-a");
        assert_eq!(shown(&seen).last(), Some(&(MAIN.into(), 41001)));
        host.command(Verb::Close, "k95-b");
        assert!(began.elapsed() < Duration::from_secs(2), "nothing waited on the stalled handshake");
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked)]);
        until("the stalled child to be killed", || {
            host.tick();
            !alive(p)
        });
        for _ in 0..5 {
            assert!(host.tick());
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked)], "the closed board stays closed");
        host.shutdown();
    }

    #[test]
    fn shutdown_kills_a_restart_still_waiting_for_its_handshake() {
        let (host, _) = host(|_, n| if n == 1 { exits(41001, 3) } else { WAIT.into() });
        host.first("k95-a", host.start("k95-a").unwrap());
        until("the stalled restart", || {
            host.tick();
            stalled(&host, "k95-a").is_some()
        });
        let p = stalled(&host, "k95-a").unwrap();
        let began = Instant::now();
        host.shutdown();
        assert!(began.elapsed() < Duration::from_secs(5));
        assert!(!alive(p));
        assert!(!host.tick());
    }

    #[test]
    fn a_login_path_is_added_after_the_path_the_app_got() {
        assert_eq!(merge_path("/fnm/node24/bin:/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin:/usr/local/bin"), "/fnm/node24/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
        assert_eq!(merge_path("/usr/bin:/bin", ""), "/usr/bin:/bin");
        assert_eq!(merge_path("", "/opt/homebrew/bin::/usr/bin"), "/opt/homebrew/bin:/usr/bin");
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
    fn the_navigation_lock_allows_every_hosted_daemon_and_nothing_else() {
        let at = |u: &str, ports: &[u16]| on_daemon(&u.parse().unwrap(), ports);
        assert!(at("http://127.0.0.1:41234/?k95=x", &[41234]));
        assert!(!at("http://127.0.0.1:41235/", &[41234]) && !at("http://localhost:41234/", &[41234]) && !at("https://127.0.0.1:41234/", &[41234]));
        assert!(at("http://127.0.0.1:41235/?k95=y", &[41234, 41235]) && at("http://127.0.0.1:41234/", &[41234, 41235]));
        assert!(!at("http://127.0.0.1/", &[80]) && !at("http://127.0.0.1:41234/", &[]));
    }

    #[test]
    fn keys_drop_the_verbatim_prefix_and_keep_a_missing_path() {
        let cwd = std::env::current_dir().unwrap().display().to_string();
        assert_eq!(key("."), cwd.strip_prefix(r"\\?\").unwrap_or(&cwd));
        assert!(!key(".").starts_with(r"\\?\"));
        assert_eq!(key("k95-no-such-repo"), "k95-no-such-repo");
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

    #[test]
    fn each_repo_gets_its_own_stable_webview_profile() {
        let (a, b) = (std::env::temp_dir().join("k95-profile-a"), std::env::temp_dir().join("k95-profile-b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let p = |d: &std::path::Path| profile(Some(d.display().to_string()));
        assert_ne!(p(&a), p(&b));
        assert_eq!(p(&a), profile(Some(format!("{}/", a.display())))); // the same repo spelled another way
        assert_eq!(profile(None), p(&std::env::current_dir().unwrap()));
        assert_eq!(profile(Some(String::new())), "cbf29ce484222325"); // FNV-1a offset basis: the hash is pinned
        std::fs::remove_dir(&a).unwrap();
        std::fs::remove_dir(&b).unwrap();
    }

    /// The UI calls no Tauri command, so none may answer it: core plugin commands and unknown names alike.
    #[test]
    fn webview_cannot_call_any_tauri_command() {
        let app = mock_builder().build(tauri::generate_context!(test = true)).unwrap();
        let origin: tauri::Url = "http://127.0.0.1:41234/".parse().unwrap();
        let w = window(&app, MAIN, origin.clone(), "Kanban95".into(), Arc::new(Mutex::new(vec![41234]))).unwrap();
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
        // Tauri created the window's (empty) profile folder; a test leaves nothing behind.
        let _ = std::fs::remove_dir(app.path().app_local_data_dir().unwrap().join("boards").join(profile(std::env::args().nth(1))));
    }
}
