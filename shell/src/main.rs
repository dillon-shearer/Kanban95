// Kanban95 shell: hosts one daemon per open project, keeps one window per board, shows one docked board at a time and
// popped-out ones beside it, restarts a daemon once if it dies, shows an error dialog when one cannot run, and takes
// every daemon and WebView2 down with it on every exit path.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

/// 32 random bytes from the OS, hex: the shell-to-daemon secret for one daemon run (docs/SECURITY.md).
fn mint_secret() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("OS random source");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn exe_dir() -> Option<std::path::PathBuf> {
    std::env::current_exe().ok().and_then(|e| Some(e.parent()?.to_path_buf()))
}

/// The daemon the installer staged (`app/`, shell/stage.mjs): next to this exe on Windows, in the bundle's
/// `Contents/Resources` on macOS (the exe is in `Contents/MacOS`). None in dev.
fn staged(exe_dir: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
    exe_dir.into_iter().flat_map(|d| [d.join("app"), d.join("../Resources/app")]).map(|a| a.join("daemon/dist/server.js")).find(|p| p.is_file())
}

/// The staged daemon, else the repo's build (dev).
fn daemon_script() -> std::path::PathBuf {
    staged(exe_dir().as_deref()).unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/../daemon/dist/server.js").into())
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

/// The Node the installer put next to this exe (bundle.externalBin, shell/stage.mjs), else `node` from PATH (dev).
fn node_exe(exe_dir: Option<&std::path::Path>) -> std::path::PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    exe_dir.map(|d| d.join(name)).filter(|p| p.is_file()).unwrap_or_else(|| "node".into())
}

/// `node daemon/dist/server.js <repo>`; no repo (`""`): the daemon picks the first project, or serves first-run setup.
fn node(repo: &str) -> Command {
    let exe = std::env::current_exe().ok();
    let mut cmd = Command::new(node_exe(exe.as_deref().and_then(|e| e.parent())));
    cmd.arg(daemon_script());
    if !repo.is_empty() {
        cmd.arg(repo);
    }
    #[cfg(all(windows, not(debug_assertions)))]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000);
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
    let program = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd
        .env("KANBAN95_SECRET", &secret)
        .env("KANBAN95_SHELL", "1")
        .env("KANBAN95_SHELL_ID", std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Node.js ({program}): {e}."))?;
    let out = child.stdout.take().expect("daemon stdout");
    Ok((child, secret, out))
}

const HANDSHAKE_WAIT: Duration = Duration::from_secs(60);

const OPEN_WAIT: Duration = Duration::from_secs(20);

fn handshake(out: ChildStdout, wait: Duration) -> Result<(u16, Lines), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(out).lines();
        let first = lines.next().and_then(Result::ok).unwrap_or_default();
        let _ = tx.send((first, lines));
    });
    let Ok((first, lines)) = rx.recv_timeout(wait) else {
        return Err(format!("The Kanban95 daemon did not say its port within {wait:?}.\n\nCheck the console for the daemon's error."));
    };
    match first.strip_prefix("KANBAN95 port=").and_then(|p| p.trim().parse().ok()) {
        Some(port) => Ok((port, lines)),
        None => Err(format!(
            "The Kanban95 daemon did not start (it said {first:?}).\n\nRun `npm run build` and check the console for the daemon's error."
        )),
    }
}

/// Starts a daemon and waits for its handshake; a daemon that fails it is killed.
fn start(cmd: Command, wait: Duration) -> Result<Started, String> {
    let (mut child, secret, out) = spawn(cmd)?;
    match handshake(out, wait) {
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

const SPLASH: &str = "splash";

const SPLASH_AFTER: Duration = Duration::from_millis(400);

const SHOW_WAIT: Duration = Duration::from_secs(10);

const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);

/// A command a daemon prints on stdout after its port line (docs/ARCHITECTURE.md -> Hosted boards).
#[derive(Debug, PartialEq, Clone, Copy)]
enum Verb {
    Open,
    Switch,
    Popout,
    Dock,
    Close,
    Restart,
    Check,
    CheckNow,
    Update,
    Pick,
}

fn parse(line: &str) -> Option<(Verb, &str)> {
    let (verb, path) = line.strip_prefix("KANBAN95 ")?.split_once('=')?;
    let verb = match verb {
        "open" => Verb::Open,
        "switch" => Verb::Switch,
        "popout" => Verb::Popout,
        "dock" => Verb::Dock,
        "close" => Verb::Close,
        "restart" => Verb::Restart,
        "check" => Verb::Check,
        "checknow" => Verb::CheckNow,
        "update" => Verb::Update,
        "pick" => Verb::Pick,
        _ => return None,
    };
    (!path.is_empty()).then_some((verb, path))
}

fn pick_args(rest: &str) -> Option<(bool, &str)> {
    let mut words = rest.rsplitn(3, ' ');
    let (token, kind, _path) = (words.next()?, words.next()?, words.next()?);
    let folder = match kind {
        "folder" => true,
        "file" => false,
        _ => return None,
    };
    (!token.is_empty() && token.len() <= 64 && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some((folder, token))
}

#[derive(Debug, PartialEq, Clone)]
struct Daemon {
    port: u16,
    secret: String,
}

/// What the host asks of the windows and the updater, applied by `apply` in the app and recorded in tests.
#[derive(Debug, PartialEq)]
enum Effect {
    Open { label: String, url: Url, title: String },
    Show { label: String, like: Option<String> },
    Hide(String),
    Navigate { label: String, url: Url, title: String },
    Own(String, bool),
    Focus(String),
    Close(String),
    Splash(bool),
    Error(String),
    Exit(i32),
    Check { to: Daemon, manual: bool },
    Install(Daemon),
    Tell(Daemon, &'static str, String),
    Pick { to: Daemon, window: String, folder: bool, token: String },
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
    stopping: Option<Instant>,
    waiting: Option<Instant>,
}

#[derive(Default)]
struct Table {
    boards: BTreeMap<String, Board>,
    main: String,
    opening: BTreeSet<String>,
    splash: bool,
    closing: Vec<(Child, Instant)>,
    done: bool,
    restarts: u64,
    failed: bool,
    checked: Option<Instant>,
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
    installed: bool,
    log: Option<std::path::PathBuf>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A board's window label, from the repo path.
fn label(repo: &str) -> String {
    format!("board-{}", fnv(repo))
}

fn open(repo: &str, b: &Board) -> Effect {
    Effect::Open { label: label(repo), url: url(b.port, &b.secret, b.place), title: title(Some(repo.into())) }
}

fn take_main(t: &mut Table, repo: &str, fx: &mut Vec<Effect>) {
    let like = (t.main != repo && t.boards.contains_key(&t.main)).then(|| label(&t.main));
    fx.push(Effect::Show { label: label(repo), like: like.clone() });
    fx.extend(like.map(Effect::Hide));
    t.main = repo.into();
}

impl Host {
    fn new(launch: impl Fn(&str) -> Command + Send + Sync + 'static, installed: bool, log: Option<std::path::PathBuf>) -> Arc<Self> {
        Arc::new(Host { table: Mutex::default(), ports: Ports::default(), launch: Box::new(launch), ui: OnceLock::new(), installed, log })
    }

    fn log(&self, line: &str) {
        if let Some(to) = &self.log {
            log(to, line);
        }
    }

    fn start(&self, repo: &str) -> Result<Started, String> {
        start((self.launch)(repo), OPEN_WAIT)
    }

    fn emit(&self, fx: Vec<Effect>) {
        for f in &fx {
            if let Effect::Error(e) = f {
                self.log(e);
            }
        }
        if let Some(ui) = self.ui.get() {
            fx.into_iter().for_each(ui);
        }
    }

    fn sync(&self, t: &Table) {
        *lock(&self.ports) = t.boards.values().map(|b| b.port).collect();
    }

    /// Reads the daemon's stdout to EOF, which also keeps the pipe from filling, and acts on its commands.
    fn board(self: &Arc<Self>, s: Started, place: Place, crashed: bool, fresh: bool) -> Board {
        let host = self.clone();
        let lines = s.lines;
        let me = Daemon { port: s.port, secret: s.secret.clone() };
        std::thread::spawn(move || {
            let mut fresh = fresh;
            for line in lines.map_while(Result::ok) {
                eprintln!("[daemon] {line}");
                match parse(&line) {
                    Some((Verb::Check, _)) => host.updates(Verb::Check, &me, std::mem::take(&mut fresh)),
                    Some((verb @ (Verb::CheckNow | Verb::Update), _)) => host.updates(verb, &me, false),
                    Some((Verb::Pick, rest)) => match pick_args(rest) {
                        Some((folder, token)) => host.pick(&me, folder, token),
                        None => eprintln!("[shell] ignored a pick line without a kind and token"),
                    },
                    Some((verb, path)) => host.command(verb, path, Some(&me)),
                    None => {}
                }
            }
        });
        Board { child: s.child, port: s.port, secret: s.secret, place, crashed, restarting: None, pending: None, stopping: None, waiting: None }
    }

    fn restart(self: &Arc<Self>, repo: String, gen: u64, requested: bool) {
        let (child, secret, out) = match spawn((self.launch)(&repo)) {
            Ok(s) => s,
            Err(e) => return self.restarted(&repo, gen, requested, Err(e)),
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
        let shake = handshake(out, HANDSHAKE_WAIT).map(|(port, lines)| (port, secret, lines));
        self.restarted(&repo, gen, requested, shake);
    }

    fn restarted(self: &Arc<Self>, repo: &str, gen: u64, requested: bool, shake: Result<(u16, String, Lines), String>) {
        let mut fx = vec![];
        let mut t = lock(&self.table);
        let Some(old) = t.boards.get_mut(repo).filter(|b| b.restarting == Some(gen)) else {
            return;
        };
        let child = old.pending.take();
        match (shake, child) {
            (Ok((port, secret, lines)), Some(child)) => {
                let (place, crashed) = (old.place, old.crashed);
                let b = self.board(Started { child, port, secret, lines }, place, crashed, requested);
                fx.push(Effect::Navigate { label: label(repo), url: url(b.port, &b.secret, place), title: title(Some(repo.into())) });
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
        let b = self.board(s, Place::Docked, false, true);
        t.boards.insert(repo.into(), b);
        t.main = repo.into();
        self.sync(&t);
    }

    fn boot(self: &Arc<Self>, repo: String, (mut child, secret, out): (Child, String, ChildStdout), spawned: Instant) -> bool {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if std::env::var_os("KANBAN95_SPLASH_TEST").is_some() {
                std::thread::sleep(Duration::from_secs(3));
            }
            let _ = tx.send(handshake(out, HANDSHAKE_WAIT));
        });
        let (shake, splash) = match rx.recv_timeout(SPLASH_AFTER.saturating_sub(spawned.elapsed())) {
            Ok(shake) => (shake, false),
            Err(_) => {
                self.emit(vec![Effect::Splash(true)]);
                (rx.recv().unwrap_or_else(|_| Err("The Kanban95 daemon's handshake was lost.".into())), true)
            }
        };
        match shake {
            Ok((port, lines)) => {
                self.first(&repo, Started { child, port, secret, lines });
                let created = {
                    let mut t = lock(&self.table);
                    t.splash = splash;
                    let b = t.boards.get_mut(&repo).expect("hosted");
                    b.waiting = Some(Instant::now() + SHOW_WAIT);
                    open(&repo, b)
                };
                self.emit(vec![created]);
                true
            }
            Err(e) => {
                let gone = splash.then_some(Effect::Splash(false));
                let _ = child.kill();
                let _ = child.wait();
                self.emit(gone.into_iter().chain([Effect::Error(e), Effect::Exit(1)]).collect());
                false
            }
        }
    }

    fn command(self: &Arc<Self>, verb: Verb, path: &str, from: Option<&Daemon>) {
        let repo = key(path);
        let mut fx = vec![];
        let mut t = lock(&self.table);
        if t.done {
            return;
        }
        let place = t.boards.get(&repo).map(|b| b.place);
        let waiting = t.boards.get(&repo).is_some_and(|b| b.waiting.is_some());
        match (verb, place) {
            (Verb::Open | Verb::Switch | Verb::Popout | Verb::Dock, Some(_)) if waiting => eprintln!("[shell] ignored {verb:?} for {repo}: its page is still loading"),
            (Verb::Open | Verb::Popout, Some(Place::Own)) => fx.push(Effect::Focus(label(&repo))),
            (Verb::Open | Verb::Switch, Some(Place::Docked)) => take_main(&mut t, &repo, &mut fx),
            (Verb::Open, None) => {
                if t.opening.insert(repo.clone()) {
                    let host = self.clone();
                    let from = from.cloned();
                    std::thread::spawn(move || host.open(repo, from));
                }
            }
            (Verb::Popout, Some(Place::Docked)) => {
                if t.main == repo {
                    let Some(other) = t.boards.iter().find(|(r, b)| **r != repo && b.place == Place::Docked && b.waiting.is_none()).map(|(r, _)| r.clone()) else {
                        eprintln!("[shell] {repo} is the only board in the main window; it stays there");
                        return;
                    };
                    fx.push(Effect::Show { label: label(&other), like: Some(label(&repo)) });
                    t.main = other;
                }
                t.boards.get_mut(&repo).expect("hosted").place = Place::Own;
                fx.push(Effect::Own(label(&repo), true));
                fx.push(Effect::Show { label: label(&repo), like: None });
            }
            (Verb::Dock, Some(Place::Own)) => {
                t.boards.get_mut(&repo).expect("hosted").place = Place::Docked;
                fx.push(Effect::Own(label(&repo), false));
                take_main(&mut t, &repo, &mut fx);
            }
            (Verb::Close, Some(_)) => self.close(&mut t, &repo, &mut fx),
            (Verb::Restart, Some(_)) => {
                let b = t.boards.get_mut(&repo).expect("hosted");
                if b.restarting.is_none() && b.stopping.is_none() {
                    drop(b.child.stdin.take());
                    b.stopping = Some(Instant::now() + STOP_WAIT);
                }
            }
            (verb, _) => eprintln!("[shell] ignored {verb:?} for {repo}: not a board in that state"),
        }
        drop(t);
        self.emit(fx);
    }

    fn updates(&self, verb: Verb, to: &Daemon, fresh: bool) {
        let fx = {
            let mut t = lock(&self.table);
            if t.done {
                return;
            }
            match verb {
                _ if !self.installed => {
                    eprintln!("[shell] not the installed app: no update check");
                    (verb == Verb::CheckNow).then(|| Effect::Tell(to.clone(), UPDATE_REPORT, failed("Only the installed Kanban95 app checks for updates.")))
                }
                Verb::Update => Some(Effect::Install(to.clone())),
                Verb::Check if !fresh && t.checked.is_some_and(|at| at.elapsed() < CHECK_EVERY) => {
                    eprintln!("[shell] update check skipped: the last one was under an hour ago");
                    None
                }
                _ => {
                    t.checked = Some(Instant::now());
                    Some(Effect::Check { to: to.clone(), manual: verb == Verb::CheckNow })
                }
            }
        };
        self.emit(fx.into_iter().collect());
    }

    fn pick(&self, to: &Daemon, folder: bool, token: &str) {
        let window = {
            let t = lock(&self.table);
            if t.done {
                return;
            }
            label(t.boards.iter().find(|(_, b)| b.port == to.port).map_or(&t.main, |(repo, _)| repo))
        };
        self.emit(vec![Effect::Pick { to: to.clone(), window, folder, token: token.into() }]);
    }

    fn open(self: &Arc<Self>, repo: String, from: Option<Daemon>) {
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
                let mut b = self.board(s, Place::Docked, false, false);
                b.waiting = Some(Instant::now() + SHOW_WAIT);
                fx.push(open(&repo, &b));
                t.boards.insert(repo.clone(), b);
                self.sync(&t);
            }
            Err(e) => {
                if let Some(to) = from {
                    fx.push(Effect::Tell(to, OPEN_REPORT, serde_json::json!({ "path": repo, "error": e }).to_string()));
                }
                fx.push(Effect::Error(e));
            }
        }
        drop(t);
        self.emit(fx);
    }

    /// A board window's page finished loading: a new board waiting for it takes the main window.
    fn loaded(&self, window: &str) {
        let mut fx = vec![];
        let mut t = lock(&self.table);
        if t.done {
            return;
        }
        if let Some(repo) = t.boards.iter().find(|(r, b)| b.waiting.is_some() && label(r) == window).map(|(r, _)| r.clone()) {
            self.reveal(&mut t, &repo, &mut fx);
        }
        drop(t);
        self.emit(fx);
    }

    fn reveal(&self, t: &mut Table, repo: &str, fx: &mut Vec<Effect>) {
        t.boards.get_mut(repo).expect("hosted").waiting = None;
        take_main(t, repo, fx);
        if std::mem::take(&mut t.splash) {
            fx.push(Effect::Splash(false));
        }
    }

    /// Drops a board from the table and closes its window; if it was the shown docked board, another takes its place.
    fn remove(&self, t: &mut Table, repo: &str, fx: &mut Vec<Effect>) -> Option<Board> {
        let b = t.boards.remove(repo)?;
        if t.main == repo {
            let mut ready = t.boards.iter().filter(|(_, b)| b.waiting.is_none());
            let next = ready.clone().find(|(_, b)| b.place == Place::Docked).or_else(|| ready.next());
            if let Some(next) = next.map(|(r, _)| r.clone()) {
                let nb = t.boards.get_mut(&next).expect("hosted");
                if nb.place == Place::Own {
                    nb.place = Place::Docked;
                    fx.push(Effect::Own(label(&next), false));
                }
                fx.push(Effect::Show { label: label(&next), like: Some(label(repo)) });
                t.main = next;
            }
        }
        fx.push(Effect::Close(label(repo)));
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
        match t.boards.iter().find(|(r, _)| label(r) == window).map(|(r, b)| (r.clone(), b.place)) {
            Some((repo, Place::Own)) => self.close(&mut t, &repo, &mut fx),
            Some((_, Place::Docked)) => fx.push(Effect::Exit(0)),
            None => {}
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
                let line = format!("[shell] a closed daemon did not stop in {STOP_WAIT:?}; killing it");
                eprintln!("{line}");
                self.log(&line);
                let _ = child.kill();
                let _ = child.wait();
                false
            }
            _ => false,
        });
        for (repo, b) in t.boards.iter_mut().filter(|(_, b)| b.restarting.is_none() && b.stopping.is_some_and(|until| now >= until)) {
            eprintln!("[shell] {repo}: daemon did not stop in {STOP_WAIT:?} for its restart; killing it");
            let _ = b.child.kill();
        }
        let late: Vec<_> = t.boards.iter().filter(|(_, b)| b.waiting.is_some_and(|until| now >= until)).map(|(r, _)| r.clone()).collect();
        for repo in late {
            eprintln!("[shell] {repo}: the page did not load in {SHOW_WAIT:?}; showing its window anyway");
            self.reveal(&mut t, &repo, &mut fx);
        }
        let exited: Vec<_> = t
            .boards
            .iter_mut()
            .filter(|(_, b)| b.restarting.is_none())
            .filter_map(|(r, b)| Some((r.clone(), b.child.try_wait().ok()??)))
            .collect();
        for (repo, status) in exited {
            let requested = status.code() == Some(RESTART_REQUESTED) || t.boards[&repo].stopping.is_some();
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
            std::thread::spawn(move || host.restart(repo, gen, requested));
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

fn log_path() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("KANBAN95_SHELL_LOG") {
        return p.into();
    }
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join("Library/Logs"))
    } else {
        std::env::var_os("LOCALAPPDATA").map(Into::into)
    };
    base.unwrap_or_else(std::env::temp_dir).join("Kanban95").join("shell.log")
}

fn iso(secs: u64) -> String {
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3_600, rem / 60 % 60, rem % 60)
}

fn log(to: &std::path::Path, text: &str) {
    use std::io::Write;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let text = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ");
    if let Some(dir) = to.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(to).and_then(|mut f| writeln!(f, "{} {text}", iso(now)));
}

// ponytail: the log is emptied at startup once past 1 MB; rotate instead if operators need older lines.
const LOG_CAP: u64 = 1 << 20;

fn trim_log(to: &std::path::Path) {
    if std::fs::metadata(to).is_ok_and(|m| m.len() > LOG_CAP) {
        let _ = std::fs::File::create(to);
    }
}

fn error_dialog(text: &str) {
    log(&log_path(), text);
    show_error(text);
}

fn show_error(text: &str) {
    eprintln!("Kanban95: {text}");
    native_error(&format!("{text}

Details: {}", log_path().display()));
}

/// Native Windows error box: works before any window exists and while the webview is dead.
#[cfg(windows)]
fn native_error(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    // SAFETY: both strings are NUL-terminated and outlive the call; a null owner window is allowed.
    unsafe { MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide("Kanban95").as_ptr(), MB_OK | MB_ICONERROR | MB_SETFOREGROUND) };
}
#[cfg(not(windows))]
fn native_error(text: &str) {
    let shown = std::panic::catch_unwind(|| {
        rfd::MessageDialog::new()
            .set_title("Kanban95")
            .set_description(text)
            .set_level(rfd::MessageLevel::Error)
            .set_buttons(rfd::MessageButtons::Ok)
            .show()
    });
    if shown.is_err() {
        eprintln!("[shell] could not show the error dialog");
    }
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
        } else {
            let _ = JOB.set(job as usize);
        }
    }
}
#[cfg(not(windows))]
fn kill_children_with_us() {}

#[cfg(windows)]
static JOB: OnceLock<usize> = OnceLock::new();

#[cfg(windows)]
fn let_installer_outlive_us() {
    use windows_sys::Win32::System::JobObjects::*;
    let Some(&job) = JOB.get() else { return };
    unsafe {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        let size = std::mem::size_of_val(&info) as u32;
        if SetInformationJobObject(job as _, JobObjectExtendedLimitInformation, &info as *const _ as _, size) == 0 {
            eprintln!("[shell] could not let the installer out of the kill-on-close job: {}", std::io::Error::last_os_error());
        }
    }
}
#[cfg(not(windows))]
fn let_installer_outlive_us() {}

const UPDATE_URL: &str = "KANBAN95_UPDATE_URL";

fn endpoint(var: Option<String>) -> Result<Option<Url>, String> {
    let Some(var) = var else { return Ok(None) };
    let url: Url = var.parse().map_err(|e| format!("{UPDATE_URL} is not a URL: {e}"))?;
    let ok = url.scheme() == "https" || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1"));
    ok.then_some(Some(url)).ok_or_else(|| format!("{UPDATE_URL} must be an https URL, or http on 127.0.0.1"))
}

fn updater<R: Runtime>(app: &AppHandle<R>) -> Result<Updater, String> {
    let mut b = app.updater_builder().timeout(Duration::from_secs(30));
    if let Some(url) = endpoint(std::env::var(UPDATE_URL).ok())? {
        b = b.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let a = app.clone();
    b.on_before_exit(move || {
        let_installer_outlive_us();
        a.state::<Arc<Host>>().shutdown();
        a.cleanup_before_exit();
    })
    .build()
    .map_err(|e| e.to_string())
}

fn failed(error: &str) -> String {
    serde_json::json!({ "state": "failed", "error": error }).to_string()
}

fn outcome(found: &Result<Option<String>, String>, current: &str, manual: bool) -> (String, Option<String>) {
    match found {
        Ok(Some(version)) => (
            format!("[shell] Kanban95 v{version} is available (this is v{current})"),
            Some(serde_json::json!({ "state": "available", "version": version, "current": current }).to_string()),
        ),
        Ok(None) => (
            format!("[shell] Kanban95 v{current} is up to date"),
            manual.then(|| serde_json::json!({ "state": "current", "current": current }).to_string()),
        ),
        Err(e) => (format!("[shell] update check failed: {e}"), manual.then(|| failed(&format!("Could not check for updates: {e}")))),
    }
}

fn post(to: &Daemon, path: &str, body: &str, what: &str) {
    use std::io::{Read, Write};
    let sent = std::net::TcpStream::connect(("127.0.0.1", to.port)).and_then(|mut s| {
        s.set_read_timeout(Some(Duration::from_secs(10)))?;
        let port = to.port;
        let secret = &to.secret;
        let len = body.len();
        write!(s, "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nCookie: k95={secret}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}")?;
        let mut status = [0u8; 12];
        s.read_exact(&mut status)?;
        Ok(status)
    });
    match sent {
        Ok(status) if status.starts_with(b"HTTP/1.1 2") => {}
        Ok(status) => eprintln!("[shell] the daemon on port {} refused {what}: {}", to.port, String::from_utf8_lossy(&status)),
        Err(e) => eprintln!("[shell] could not send {what} to the daemon on port {}: {e}", to.port),
    }
}

const UPDATE_REPORT: &str = "/api/update/shell";

const OPEN_REPORT: &str = "/api/open/shell";

fn tell(to: &Daemon, body: &str) {
    post(to, UPDATE_REPORT, body, "an update report");
}

fn answer_pick(to: &Daemon, token: &str, picked: Option<std::path::PathBuf>) {
    let body = match picked {
        Some(p) => serde_json::json!({ "path": p.to_string_lossy() }),
        None => serde_json::json!({ "cancelled": true }),
    };
    post(to, &format!("/api/pick/{token}"), &body.to_string(), "a dialog result");
}

fn pick<R: Runtime>(app: &AppHandle<R>, to: Daemon, window: String, folder: bool, token: String) {
    let handle = app.clone();
    let (back, again) = (to.clone(), token.clone());
    let opened = app.run_on_main_thread(move || {
        let mut dialog = rfd::AsyncFileDialog::new();
        if let Some(w) = handle.get_webview_window(&window) {
            dialog = dialog.set_parent(&w);
        }
        let chosen: std::pin::Pin<Box<dyn std::future::Future<Output = Option<rfd::FileHandle>> + Send>> =
            if folder { Box::pin(dialog.pick_folder()) } else { Box::pin(dialog.pick_file()) };
        std::thread::spawn(move || {
            let picked = tauri::async_runtime::block_on(chosen).map(|f| f.path().to_path_buf());
            answer_pick(&to, &token, picked);
        });
    });
    if let Err(e) = opened {
        eprintln!("[shell] could not open a file or folder dialog: {e}");
        std::thread::spawn(move || answer_pick(&back, &again, None));
    }
}

#[derive(Default)]
struct Pending(Mutex<Option<Update>>);

async fn find<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, String> {
    updater(app)?.check().await.map_err(|e| e.to_string())
}

fn check<R: Runtime>(app: AppHandle<R>, to: Daemon, manual: bool) {
    let found = tauri::async_runtime::block_on(find(&app));
    let current = app.package_info().version.to_string();
    let (line, report) = outcome(&found.as_ref().map(|u| u.as_ref().map(|u| u.version.clone())).map_err(Clone::clone), &current, manual);
    eprintln!("{line}");
    if found.is_err() {
        log(&log_path(), &line);
    }
    if let Ok(Some(update)) = found {
        *lock(&app.state::<Pending>().0) = Some(update);
    }
    if let Some(report) = report {
        tell(&to, &report);
    }
}

fn install<R: Runtime>(app: AppHandle<R>, to: Daemon) {
    let pending = lock(&app.state::<Pending>().0).take();
    let update = match pending {
        Some(u) => u,
        None => match tauri::async_runtime::block_on(find(&app)) {
            Ok(Some(u)) => u,
            Ok(None) => return tell(&to, &failed("No newer release is available now.")),
            Err(e) => return install_failed(&to, &format!("Could not check for updates: {e}")),
        },
    };
    let (mut done, mut shown) = (0u64, 0u64);
    let bytes = tauri::async_runtime::block_on(update.download(
        |chunk, total| {
            done += chunk as u64;
            let step = total.map_or(done >> 20, |t| done * 20 / t.max(1));
            if step > shown {
                shown = step;
                tell(&to, &serde_json::json!({ "state": "downloading", "done": done, "total": total }).to_string());
            }
        },
        || {},
    ));
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => return install_failed(&to, &format!("The download failed: {e}")),
    };
    tell(&to, &serde_json::json!({ "state": "installing" }).to_string());
    match update.install(bytes) {
        Ok(()) => app.restart(),
        Err(e) if lock(&app.state::<Arc<Host>>().table).done => {
            error_dialog(&format!("The update did not install: {e}

Start Kanban95 again."));
            app.exit(1);
        }
        Err(e) => install_failed(&to, &format!("The install failed: {e}")),
    }
}

fn install_failed(to: &Daemon, why: &str) {
    log(&log_path(), &format!("[shell] update install failed: {why}"));
    tell(to, &failed(why));
}

/// The daemon swaps `?k95=` for an HttpOnly cookie and redirects to `/`, so the page never holds the secret.
fn url(port: u16, secret: &str, place: Place) -> Url {
    let own = if place == Place::Own { "#own" } else { "" };
    format!("http://127.0.0.1:{port}/?k95={secret}{own}").parse().expect("daemon url")
}

/// Whether `to` is on a hosted daemon's origin, `http://127.0.0.1:<port>`.
fn on_daemon(to: &Url, ports: &[u16]) -> bool {
    to.scheme() == "http" && to.host_str() == Some("127.0.0.1") && to.port().is_some_and(|p| ports.contains(&p))
}

fn external(to: &Url) -> bool {
    to.scheme() == "https" && to.host_str().is_some()
}

#[cfg(windows)]
fn open_external(to: &Url) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    unsafe { ShellExecuteW(std::ptr::null_mut(), wide("open").as_ptr(), wide(to.as_str()).as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
}
#[cfg(not(windows))]
fn open_external(to: &Url) {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    if let Err(e) = Command::new(opener).arg(to.as_str()).spawn() {
        eprintln!("[shell] could not open {to}: {e}");
    }
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

fn data_dir<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<std::path::PathBuf> {
    // WebView2 prefers `WEBVIEW2_USER_DATA_FOLDER` to the folder passed here; passing it too keeps Tauri from
    // creating an unused profile folder.
    Ok(match std::env::var_os("WEBVIEW2_USER_DATA_FOLDER") {
        Some(dir) => dir.into(),
        None => app.path().app_local_data_dir()?.join("boards").join(profile(std::env::args().nth(1))),
    })
}

const SPLASH_SCHEME: &str = "k95splash";

fn splash_page(path: &str) -> Option<(&'static str, &'static [u8])> {
    match path {
        "/" => Some(("text/html", include_bytes!("../splash.html"))),
        "/icon.png" => Some(("image/png", include_bytes!("../icons/32x32.png"))),
        _ => None,
    }
}

fn splash_response(path: &str) -> tauri::http::Response<&'static [u8]> {
    let (status, kind, body) = match splash_page(path) {
        Some((kind, body)) => (200, kind, body),
        None => (404, "text/plain", &b""[..]),
    };
    tauri::http::Response::builder().status(status).header("Content-Type", kind).body(body).expect("splash response")
}

fn splash_url() -> Url {
    let url = if cfg!(windows) { format!("http://{SPLASH_SCHEME}.localhost/") } else { format!("{SPLASH_SCHEME}://localhost/") };
    url.parse().expect("splash url")
}

fn on_splash(to: &Url) -> bool {
    let home = splash_url();
    (to.scheme(), to.host_str(), to.port()) == (home.scheme(), home.host_str(), home.port())
}

fn splash<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(app, SPLASH, WebviewUrl::CustomProtocol(splash_url()))
        .title("Kanban95")
        .data_directory(data_dir(app)?)
        .inner_size(320.0, 120.0)
        .center()
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .on_navigation(on_splash)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .build()
}

/// A board window, hidden until shown, locked to the hosted daemons' origins. It holds no Tauri capability (there is no
/// `capabilities/` dir), so every IPC command is refused for it: the UI talks to the daemon over HTTP and never calls Tauri.
fn window<R: Runtime, M: Manager<R>>(app: &M, label: &str, url: Url, title: String, ports: Ports) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .data_directory(data_dir(app)?)
        .inner_size(1280.0, 720.0)
        .visible(false)
        // Any top-level navigation off a hosted daemon's origin is cancelled, and the CSP keeps frames and fetches on
        // the origin. No new window opens: an https one goes to the system browser, anything else is dropped.
        .on_navigation(move |to| on_daemon(to, &lock(&ports)))
        .on_new_window(|to, _| {
            if external(&to) {
                open_external(&to);
            }
            NewWindowResponse::Deny
        })
        // Navigation is pinned to the daemons' origins, so every request here comes from one. Answering in code
        // means no prompt, though the random port gives a new origin each start. Everything but the mic is denied.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Deny,
        })
        .on_page_load(|w, load| {
            if load.event() == PageLoadEvent::Finished {
                if let Some(host) = w.try_state::<Arc<Host>>() {
                    host.loaded(w.label());
                }
            }
        })
        .build()
}

/// The page's fullscreen (Start -> Full screen, F11) sets the window's, over the Windows taskbar. Tauri's own
/// ContainsFullScreenElementChanged handler, registered just before this one, would also follow the false a
/// navigation raises, so it is removed and this one is the only follower.
#[cfg(windows)]
fn follow_page_fullscreen<R: Runtime>(w: &WebviewWindow<R>) {
    use std::{cell::Cell, rc::Rc};
    use webview2_com::{ContainsFullScreenElementChangedEventHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler};
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
                    set_page_fullscreen(&core, true)?;
                }
                Ok(())
            }));
            let _ = core.add_NavigationCompleted(&handler, &mut token);
        }
    });
}
#[cfg(not(windows))]
fn follow_page_fullscreen<R: Runtime>(_: &WebviewWindow<R>) {}

#[cfg(windows)]
unsafe fn set_page_fullscreen(core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, full: bool) -> windows_core::Result<()> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::w;
    let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
    let call = if full {
        w!(r#"{"expression":"document.documentElement.requestFullscreen()","userGesture":true}"#)
    } else {
        w!(r#"{"expression":"document.fullscreenElement && document.exitFullscreen()"}"#)
    };
    core.CallDevToolsProtocolMethod(w!("Runtime.evaluate"), call, &done)
}

#[cfg(windows)]
fn page_fullscreen<R: Runtime>(w: &WebviewWindow<R>, full: bool) {
    let _ = w.with_webview(move |wv| {
        // SAFETY: COM calls on the live controller, on the main thread where with_webview runs this.
        unsafe {
            if let Ok(core) = wv.controller().CoreWebView2() {
                let _ = set_page_fullscreen(&core, full);
            }
        }
    });
}
#[cfg(not(windows))]
fn page_fullscreen<R: Runtime>(_: &WebviewWindow<R>, _: bool) {}

#[cfg(windows)]
fn no_transitions<R: Runtime>(w: &WebviewWindow<R>) {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    if let Ok(hwnd) = w.hwnd() {
        let off: i32 = 1;
        // SAFETY: a live window handle and a 4-byte BOOL that outlives the call.
        unsafe { DwmSetWindowAttribute(hwnd.0 as _, DWMWA_TRANSITIONS_FORCEDISABLED as _, &off as *const i32 as _, 4) };
    }
}
#[cfg(not(windows))]
fn no_transitions<R: Runtime>(_: &WebviewWindow<R>) {}

#[cfg(target_os = "macos")]
fn leave_fullscreen<R: Runtime>(w: &WebviewWindow<R>) {
    use objc2_foundation::NSString;
    use objc2_web_kit::{WKFullscreenState, WKWebView};
    let page_full = |w: &WebviewWindow<R>| {
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = w.with_webview(move |wv| {
            let state = unsafe { (*wv.inner().cast::<WKWebView>()).fullscreenState() };
            let _ = tx.send(state != WKFullscreenState::NotInFullscreen);
        });
        rx.recv_timeout(Duration::from_secs(1)).unwrap_or(false)
    };
    let full = |w: &WebviewWindow<R>| w.is_fullscreen().unwrap_or(false) || page_full(w);
    if !full(w) {
        return;
    }
    let _ = w.with_webview(|wv| unsafe {
        let js = NSString::from_str("document.fullscreenElement && document.exitFullscreen();0");
        (*wv.inner().cast::<WKWebView>()).evaluateJavaScript_completionHandler(&js, None);
    });
    let _ = w.set_fullscreen(false);
    let end = Instant::now() + Duration::from_secs(2);
    while full(w) && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(50));
    }
}
#[cfg(not(target_os = "macos"))]
fn leave_fullscreen<R: Runtime>(_: &WebviewWindow<R>) {}

fn take_place<R: Runtime>(b: &WebviewWindow<R>, a: &WebviewWindow<R>) {
    if a.is_minimized().unwrap_or(false) {
        return;
    }
    leave_fullscreen(a);
    leave_fullscreen(b);
    let full = a.is_fullscreen().unwrap_or(false);
    if !full && b.is_fullscreen().unwrap_or(false) {
        let _ = b.set_fullscreen(false);
        page_fullscreen(b, false);
    }
    let (Ok(at), Ok(size)) = (a.outer_position(), a.inner_size()) else { return };
    if full {
        if !b.is_fullscreen().unwrap_or(false) {
            let _ = b.set_fullscreen_on_monitor(tauri::PhysicalPosition::new(at.x as f64 + size.width as f64 / 2.0, at.y as f64 + size.height as f64 / 2.0));
            page_fullscreen(b, true);
        }
    } else if a.is_maximized().unwrap_or(false) {
        if !b.is_maximized().unwrap_or(false) {
            let screen = |w: &WebviewWindow<R>| w.current_monitor().ok().flatten().map(|m| *m.position());
            if screen(b) != screen(a) {
                let _ = b.set_position(at);
            }
            let _ = b.maximize();
        }
    } else {
        let _ = b.set_position(at);
        let _ = b.set_size(size);
    }
}

fn board_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<WebviewWindow<R>> {
    app.webview_windows().into_values().filter(|w| w.label() != SPLASH).collect()
}

#[cfg(target_os = "macos")]
fn navigate_keeping_fullscreen<R: Runtime>(w: &WebviewWindow<R>, url: Url) {
    use objc2_foundation::NSString;
    use objc2_web_kit::{WKFullscreenState, WKWebView};
    use std::sync::atomic::{AtomicBool, Ordering};
    let win = w.clone();
    let _ = w.with_webview(move |wv| {
        let state = unsafe { (*wv.inner().cast::<WKWebView>()).fullscreenState() };
        let _ = win.navigate(url);
        if state != WKFullscreenState::InFullscreen && state != WKFullscreenState::EnteringFullscreen {
            return;
        }
        std::thread::spawn(move || {
            let done = Arc::new(AtomicBool::new(false));
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(100));
                if done.load(Ordering::Relaxed) {
                    return;
                }
                let done = done.clone();
                let _ = win.with_webview(move |wv| {
                    if done.load(Ordering::Relaxed) {
                        return;
                    }
                    unsafe {
                        let wk = &*wv.inner().cast::<WKWebView>();
                        if wk.fullscreenState() == WKFullscreenState::NotInFullscreen && !wk.isLoading() {
                            let js = NSString::from_str("document.documentElement.requestFullscreen();0");
                            wk.evaluateJavaScript_completionHandler(&js, None);
                            done.store(true, Ordering::Relaxed);
                        }
                    }
                });
            }
        });
    });
}
#[cfg(not(target_os = "macos"))]
fn navigate_keeping_fullscreen<R: Runtime>(w: &WebviewWindow<R>, url: Url) {
    let _ = w.navigate(url);
}

fn apply<R: Runtime>(app: &AppHandle<R>, ports: &Ports, fx: Effect) {
    match fx {
        Effect::Open { label, url, title } => match window(app, &label, url, title, ports.clone()) {
            Ok(w) => {
                follow_page_fullscreen(&w);
                no_transitions(&w);
            }
            Err(e) if board_windows(app).is_empty() => {
                error_dialog(&format!("Could not open the board window: {e}"));
                app.exit(1);
            }
            Err(e) => {
                let line = format!("[shell] could not open a window: {e}");
                eprintln!("{line}");
                log(&log_path(), &line);
            }
        },
        Effect::Show { label, like } => {
            if let Some(w) = app.get_webview_window(&label) {
                if let Some(a) = like.and_then(|l| app.get_webview_window(&l)) {
                    take_place(&w, &a);
                }
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        Effect::Hide(label) => {
            let shown = board_windows(app).into_iter().any(|w| w.label() != label && w.is_visible().unwrap_or(false));
            if let (true, Some(w)) = (shown, app.get_webview_window(&label)) {
                let _ = w.hide();
            }
        }
        Effect::Navigate { label, url, title } => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.set_title(&title);
                navigate_keeping_fullscreen(&w, url);
            }
        }
        Effect::Own(label, own) => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.eval(if own { "history.replaceState(null, '', '#own')" } else { "history.replaceState(null, '', location.pathname + location.search)" });
            }
        }
        Effect::Splash(true) => {
            if let Err(e) = splash(app) {
                let line = format!("[shell] could not open the splash: {e}");
                eprintln!("{line}");
                log(&log_path(), &line);
            }
        }
        Effect::Splash(false) => {
            if let Some(w) = app.get_webview_window(SPLASH) {
                let _ = w.hide();
                if !board_windows(app).is_empty() {
                    let _ = w.destroy();
                }
            }
        }
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
        Effect::Error(e) => show_error(&e),
        Effect::Exit(code) => app.exit(code),
        Effect::Check { to, manual } => {
            let app = app.clone();
            std::thread::spawn(move || check(app, to, manual));
        }
        Effect::Install(to) => {
            let app = app.clone();
            std::thread::spawn(move || install(app, to));
        }
        Effect::Tell(to, path, body) => {
            let what = if path == OPEN_REPORT { "an open failure" } else { "an update report" };
            std::thread::spawn(move || post(&to, path, &body, what));
        }
        Effect::Pick { to, window, folder, token } => pick(app, to, window, folder, token),
    }
}

fn main() {
    if std::env::var_os("KANBAN95_AGENT").is_some() {
        eprintln!("Kanban95 is already running; agents verify headlessly, see docs/AGENTS.md");
        std::process::exit(1);
    }
    kill_children_with_us();
    add_login_path();
    // The shell's first argument, if any, is the repo of its first board. Without one (Start menu, Dock) the daemon decides,
    // and the board is keyed "" (docs/ARCHITECTURE.md -> Startup without an argument).
    // ponytail: a board keyed "" that another board then opens by path gets a second daemon; re-keying on the handshake would fix it.
    let repo = std::env::args().nth(1).map(|a| key(&a)).unwrap_or_default();
    let installed = staged(exe_dir().as_deref()).is_some();
    trim_log(&log_path());
    let host = Host::new(node, installed, Some(log_path()));
    let first = match spawn((host.launch)(&repo)) {
        Ok(spawned) => spawned,
        Err(e) => {
            error_dialog(&e);
            std::process::exit(1);
        }
    };
    let spawned = Instant::now();
    let setup = host.clone();

    let mut builder = tauri::Builder::default();
    if installed {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .manage(host)
        .manage(Pending::default())
        .register_uri_scheme_protocol(SPLASH_SCHEME, |_, req| splash_response(req.uri().path()))
        .setup(move |app| {
            let host = setup;
            let (handle, ports) = (app.handle().clone(), host.ports.clone());
            let _ = host.ui.set(Box::new(move |fx| apply(&handle, &ports, fx)));
            std::thread::spawn(move || {
                if !host.boot(repo, first, spawned) {
                    return;
                }
                // ponytail: 250 ms poll so `Exit` can take every child without waiting on a blocked `wait()`.
                while host.tick() {
                    std::thread::sleep(Duration::from_millis(250));
                }
            });
            Ok(())
        })
        .on_window_event(|w, event| match event {
            WindowEvent::CloseRequested { api, .. } if w.label() == SPLASH => api.prevent_close(),
            WindowEvent::Destroyed =>w.state::<Arc<Host>>().window_closed(w.label()),
            _ => {}
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
    const WAIT: &str = "exec cat";
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
        host_of(false, script)
    }

    fn host_of(installed: bool, script: impl Fn(&str, usize) -> String + Send + Sync + 'static) -> (Arc<Host>, Arc<Mutex<Vec<Effect>>>) {
        let starts = Mutex::new(BTreeMap::<String, usize>::new());
        let host = Host::new(
            move |repo| {
                let n = {
                    let mut s = lock(&starts);
                    let n = s.entry(repo.into()).or_default();
                    *n += 1;
                    *n
                };
                stand_in(script(repo, n))
            },
            installed,
            None,
        );
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

    fn shown(seen: &Mutex<Vec<Effect>>) -> Vec<(String, Option<String>)> {
        lock(seen)
            .iter()
            .filter_map(|f| match f {
                Effect::Show { label, like } => Some((label.clone(), like.clone())),
                _ => None,
            })
            .collect()
    }

    fn navigated(seen: &Mutex<Vec<Effect>>) -> Vec<(String, u16)> {
        lock(seen)
            .iter()
            .filter_map(|f| match f {
                Effect::Navigate { label, url, .. } => Some((label.clone(), url.port()?)),
                _ => None,
            })
            .collect()
    }

    fn take(seen: &Mutex<Vec<Effect>>) -> Vec<Effect> {
        std::mem::take(&mut *lock(seen))
    }

    fn show(repo: &str, like: Option<&str>) -> Effect {
        Effect::Show { label: label(repo), like: like.map(label) }
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

    fn open_loaded(host: &Arc<Host>, repo: &str) {
        host.command(Verb::Open, repo, None);
        until("the board", || hosted(host).iter().any(|(r, _)| r == repo));
        host.loaded(&label(repo));
    }

    #[test]
    fn parses_every_command_and_nothing_else() {
        assert_eq!(parse("KANBAN95 open=C:\\a b\\c"), Some((Verb::Open, "C:\\a b\\c")));
        assert_eq!(parse("KANBAN95 switch=x"), Some((Verb::Switch, "x")));
        assert_eq!(parse("KANBAN95 popout=x"), Some((Verb::Popout, "x")));
        assert_eq!(parse("KANBAN95 dock=x"), Some((Verb::Dock, "x")));
        assert_eq!(parse("KANBAN95 close=x=y"), Some((Verb::Close, "x=y")));
        assert_eq!(parse("KANBAN95 restart=x"), Some((Verb::Restart, "x")));
        assert_eq!(parse("KANBAN95 check=x"), Some((Verb::Check, "x")));
        assert_eq!(parse("KANBAN95 checknow=x"), Some((Verb::CheckNow, "x")));
        assert_eq!(parse("KANBAN95 update=x"), Some((Verb::Update, "x")));
        assert_eq!(parse("KANBAN95 pick=C:\\a b folder 0a1b"), Some((Verb::Pick, "C:\\a b folder 0a1b")));
        for bad in ["KANBAN95 open=", "KANBAN95 port=41234", "KANBAN95 fly=x", "KANBAN95 open", "kanban95 open=x", " KANBAN95 open=x", "listening"] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_pick_line_takes_its_kind_and_token_from_the_end_and_refuses_anything_else() {
        assert_eq!(pick_args("C:\\a b folder 0a1b"), Some((true, "0a1b")));
        assert_eq!(pick_args("/x/y file ff"), Some((false, "ff")));
        assert_eq!(pick_args(" folder 0a1b"), Some((true, "0a1b")));
        let long = "a".repeat(65);
        for bad in ["folder 0a1b", "x disk 0a1b", "x folder ", "x folder 0A1B", "x folder 0a1b\r\nHost: evil", "x file a/b", &format!("x file {long}")] {
            assert_eq!(pick_args(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_pick_line_asks_for_a_dialog_and_its_answer_is_posted_to_the_daemon_that_printed_it() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (host, seen) = host(move |_, _| up(port, &format!("echo KANBAN95 pick=k95-a disk 0a1b{THEN}echo KANBAN95 pick=k95-a folder 0a1b{THEN}")));
        host.first("k95-a", host.start("k95-a").unwrap());
        let picks = || {
            lock(&seen)
                .iter()
                .filter_map(|f| match f {
                    Effect::Pick { to, window, folder, token } => Some((to.clone(), window.clone(), *folder, token.clone())),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        until("the dialog request", || !picks().is_empty());
        let secret = lock(&host.table).boards["k95-a"].secret.clone();
        let (to, window, folder, token) = picks().remove(0);
        assert_eq!(picks().len(), 1);
        assert_eq!((&to, window.as_str(), folder, token.as_str()), (&Daemon { port, secret: secret.clone() }, label("k95-a").as_str(), true, "0a1b"));

        let server = std::thread::spawn(move || {
            let mut reqs = vec![];
            for _ in 0..2 {
                let (mut s, _) = listener.accept().unwrap();
                let mut req = String::new();
                let mut buf = [0u8; 1024];
                while !req.ends_with('}') {
                    let n = s.read(&mut buf).unwrap();
                    req.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
                s.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();
                reqs.push(req);
            }
            reqs
        });
        answer_pick(&to, &token, Some("C:\\a b\\c".into()));
        answer_pick(&to, &token, None);
        let reqs = server.join().unwrap();
        for req in &reqs {
            assert!(req.starts_with("POST /api/pick/0a1b HTTP/1.1\r\n"), "{req}");
            assert!(req.contains(&format!("Cookie: k95={secret}\r\n")) && !req.to_lowercase().contains("origin:"), "{req}");
        }
        assert!(reqs[0].ends_with(r#"{"path":"C:\\a b\\c"}"#), "{}", reqs[0]);
        assert!(reqs[1].ends_with(r#"{"cancelled":true}"#), "{}", reqs[1]);
        host.shutdown();
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
        until("the second board", || hosted(&host).len() == 2);
        host.loaded(&label("k95-b"));
        assert!(shown(&seen).contains(&(label("k95-b"), Some(label("k95-a")))));
        assert_eq!(std::fs::read_to_string(&id_file).unwrap().trim(), std::process::id().to_string());
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked), ("k95-b".into(), Place::Docked)]);
        assert_eq!(lock(&host.table).main, "k95-b");
        assert_eq!(*lock(&host.ports), [41001, 41002]);
        host.shutdown();
        std::fs::remove_file(&id_file).unwrap();
    }

    #[test]
    fn an_open_whose_daemon_never_says_its_port_is_told_to_the_daemon_that_asked_within_the_open_wait() {
        let (host, seen) = host(|repo, _| match repo {
            "k95-a" => up(41001, &format!("echo KANBAN95 open=k95-b{THEN}")),
            _ => WAIT.into(),
        });
        let began = Instant::now();
        host.first("k95-a", host.start("k95-a").unwrap());
        let told = || {
            lock(&seen).iter().find_map(|f| match f {
                Effect::Tell(to, OPEN_REPORT, body) => Some((to.clone(), body.clone())),
                _ => None,
            })
        };
        let end = began + OPEN_WAIT + Duration::from_secs(5);
        while told().is_none() {
            assert!(Instant::now() < end, "no open failure told within {OPEN_WAIT:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
        let (to, body) = told().unwrap();
        let secret = lock(&host.table).boards["k95-a"].secret.clone();
        assert_eq!(to, Daemon { port: 41001, secret });
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["path"], "k95-b");
        assert!(body["error"].as_str().unwrap().contains("did not say its port within 20s"), "{body}");
        assert!(lock(&seen).iter().any(|f| matches!(f, Effect::Error(e) if e.contains("within 20s"))));
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked)]);
        host.shutdown();
    }

    #[test]
    fn a_first_open_creates_the_boards_window_and_a_switch_shows_and_hides_kept_windows_without_navigating() {
        let (host, seen) = host(|repo, _| up(if repo == "k95-a" { 41001 } else { 41002 }, ""));
        host.first("k95-a", host.start("k95-a").unwrap());
        host.command(Verb::Open, "k95-b", None);
        until("the second board", || hosted(&host).len() == 2);
        let fx = take(&seen);
        assert!(matches!(&fx[..], [Effect::Open { label: b, url, .. }] if *b == label("k95-b") && url.port() == Some(41002) && url.fragment().is_none()), "{fx:?}");
        host.loaded(&label("k95-b"));
        assert_eq!(take(&seen), [show("k95-b", Some("k95-a")), Effect::Hide(label("k95-a"))]);

        host.command(Verb::Switch, "k95-a", None);
        assert_eq!(take(&seen), [show("k95-a", Some("k95-b")), Effect::Hide(label("k95-b"))]);
        host.command(Verb::Switch, "k95-b", None);
        assert_eq!(take(&seen), [show("k95-b", Some("k95-a")), Effect::Hide(label("k95-a"))]);
        host.command(Verb::Open, "k95-b", None);
        assert_eq!(take(&seen), [show("k95-b", None)], "the shown board is only brought to the front");
        assert_eq!(lock(&host.table).main, "k95-b");
        host.shutdown();
    }

    #[test]
    fn switch_popout_and_dock_move_boards_between_the_windows() {
        let (host, seen) = host(|repo, _| up(if repo == "k95-a" { 41001 } else { 41002 }, ""));
        host.first("k95-a", host.start("k95-a").unwrap());
        open_loaded(&host, "k95-b");
        let b_pid = pid(&host, "k95-b");
        host.command(Verb::Switch, "k95-a", None);
        take(&seen);

        host.command(Verb::Popout, "k95-a", None);
        assert_eq!(take(&seen), [show("k95-b", Some("k95-a")), Effect::Own(label("k95-a"), true), show("k95-a", None)]);
        assert_eq!(lock(&host.table).main, "k95-b");

        host.command(Verb::Popout, "k95-b", None);
        assert!(take(&seen).is_empty(), "the only docked board stays docked");
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Own), ("k95-b".into(), Place::Docked)]);

        host.command(Verb::Switch, "k95-b", None);
        assert_eq!(take(&seen), [show("k95-b", None)], "a popped-out window is left as it is");

        host.command(Verb::Dock, "k95-a", None);
        assert_eq!(take(&seen), [Effect::Own(label("k95-a"), false), show("k95-a", Some("k95-b")), Effect::Hide(label("k95-b"))]);
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked), ("k95-b".into(), Place::Docked)]);

        host.command(Verb::Popout, "k95-b", None);
        assert_eq!(take(&seen), [Effect::Own(label("k95-b"), true), show("k95-b", None)], "a hidden board's window is shown as it was");
        host.window_closed(&label("k95-b"));
        assert_eq!(take(&seen), [Effect::Close(label("k95-b"))]);
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked)]);
        until("the popped-out board's daemon to stop", || {
            host.tick();
            !alive(b_pid)
        });
        assert!(take(&seen).is_empty(), "the docked window stays on its board");
        host.window_closed(&label("k95-a"));
        assert_eq!(take(&seen), [Effect::Exit(0)], "closing the docked window exits the shell");
        host.shutdown();
    }

    #[test]
    fn close_board_closes_its_window_and_a_shown_one_gives_its_place_to_the_next() {
        let (host, seen) = host(|repo, _| up(41000 + repo.len() as u16, ""));
        host.first("k95-a", host.start("k95-a").unwrap());
        for repo in ["k95-bb", "k95-ccc"] {
            open_loaded(&host, repo);
        }
        host.command(Verb::Popout, "k95-a", None);
        take(&seen);

        host.command(Verb::Close, "k95-bb", None);
        assert_eq!(take(&seen), [Effect::Close(label("k95-bb"))], "a hidden board's window just closes");
        host.command(Verb::Close, "k95-ccc", None);
        assert_eq!(take(&seen), [Effect::Own(label("k95-a"), false), show("k95-a", Some("k95-ccc")), Effect::Close(label("k95-ccc"))]);
        assert_eq!((hosted(&host), lock(&host.table).main.clone()), (vec![("k95-a".into(), Place::Docked)], "k95-a".into()));
        host.shutdown();
    }

    #[test]
    fn close_ends_the_last_daemon_through_stdin_eof_and_exits() {
        let (host, seen) = host(|_, _| up(41001, ""));
        host.first("k95-a", host.start("k95-a").unwrap());
        let a = pid(&host, "k95-a");
        let began = Instant::now();
        host.command(Verb::Close, "k95-a", None);
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
        open_loaded(&host, "k95-b");
        until("the crashing board to be dropped", || {
            host.tick();
            lock(&seen).iter().any(|f| matches!(f, Effect::Error(_)))
        });
        let fx = lock(&seen);
        assert!(matches!(fx.iter().find(|f| matches!(f, Effect::Error(_))), Some(Effect::Error(e)) if e.contains("stopped again")));
        assert!(!fx.iter().any(|f| matches!(f, Effect::Exit(_))));
        drop(fx);
        let b = || label("k95-b");
        assert_eq!(navigated(&seen), [(b(), 41003), (b(), 41004)]);
        assert_eq!(shown(&seen), [(b(), Some(label("k95-a"))), (label("k95-a"), Some(b()))]);
        assert_eq!(lock(&seen).last(), Some(&Effect::Close(b())));
        assert_eq!(hosted(&host), [("k95-a".into(), Place::Docked)]);
        assert_eq!(pid(&host, "k95-a"), a);
        assert!(host.tick());
        host.shutdown();
    }

    #[test]
    fn restart_stops_a_hosted_daemon_through_stdin_eof_and_starts_it_again_without_spending_its_crash_restart() {
        let (host, seen) = host(|repo, n| match (repo, n) {
            ("k95-a", _) => up(41001, ""),
            (_, 1) => up(41002, ""),
            (_, 2) => up(41003, ""),
            _ => panic!("started a third time"),
        });
        host.first("k95-a", host.start("k95-a").unwrap());
        let a = pid(&host, "k95-a");
        open_loaded(&host, "k95-b");
        host.command(Verb::Switch, "k95-a", None);
        let b = pid(&host, "k95-b");
        take(&seen);
        let began = Instant::now();
        host.command(Verb::Restart, "k95-b", None);
        host.command(Verb::Restart, "k95-b", None);
        until("the restarted board", || {
            host.tick();
            lock(&host.table).boards.get("k95-b").is_some_and(|x| x.restarting.is_none() && x.child.id() != b)
        });
        assert!(began.elapsed() < Duration::from_secs(10), "stopped by EOF, not by the 15 s kill");
        assert!(!alive(b));
        assert_eq!(pid(&host, "k95-a"), a);
        let t = lock(&host.table);
        let nb = &t.boards["k95-b"];
        assert!(!nb.crashed && nb.stopping.is_none() && nb.port == 41003);
        assert_eq!(t.main, "k95-a");
        drop(t);
        let fx = take(&seen);
        assert!(matches!(&fx[..], [Effect::Navigate { label: l, url, .. }] if *l == label("k95-b") && url.port() == Some(41003)), "only the restarted board's own hidden window loads the new port: {fx:?}");
        assert!(!lock(&seen).iter().any(|f| matches!(f, Effect::Error(_))));
        host.shutdown();
    }

    #[test]
    fn a_failed_restart_of_the_last_board_is_reported_and_exits() {
        let (host, seen) = host(|_, n| if n == 1 { exits(41001, 3) } else { "echo nope".into() });
        host.first("k95-a", host.start("k95-a").unwrap());
        until("the shell to finish", || !host.tick());
        let fx = lock(&seen);
        assert!(matches!(&fx[..], [Effect::Error(e), Effect::Close(l), Effect::Exit(1)] if e.contains("nope") && *l == label("k95-a")), "{fx:?}");
    }

    #[test]
    fn shutdown_kills_every_daemon_and_stops_the_supervisor() {
        let (host, _) = host(|repo, _| up(if repo == "k95-a" { 41001 } else { 41002 }, ""));
        host.first("k95-a", host.start("k95-a").unwrap());
        open_loaded(&host, "k95-b");
        let pids = [pid(&host, "k95-a"), pid(&host, "k95-b")];
        host.command(Verb::Popout, "k95-b", None);
        host.shutdown();
        assert!(pids.iter().all(|p| !alive(*p)));
        assert!(hosted(&host).is_empty() && lock(&host.ports).is_empty());
        assert!(!host.tick());
        host.command(Verb::Open, "k95-c", None);
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
        host.command(Verb::Open, "k95-b", None);
        until("the stalled restart", || {
            host.tick();
            stalled(&host, "k95-b").is_some()
        });
        let p = stalled(&host, "k95-b").unwrap();
        host.loaded(&label("k95-b"));
        let began = Instant::now();
        assert!(host.tick());
        host.command(Verb::Switch, "k95-a", None);
        assert_eq!(shown(&seen).last(), Some(&(label("k95-a"), Some(label("k95-b")))));
        host.command(Verb::Close, "k95-b", None);
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

    fn updates(seen: &Mutex<Vec<Effect>>) -> Vec<(u16, &'static str)> {
        lock(seen)
            .iter()
            .filter_map(|f| match f {
                Effect::Check { to, manual } => Some((to.port, if *manual { "now" } else { "auto" })),
                Effect::Install(to) => Some((to.port, "install")),
                Effect::Tell(to, UPDATE_REPORT, body) => Some((to.port, if body.contains("installed") { "dev" } else { "tell" })),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_installed_app_is_told_from_dev_by_the_staged_daemon() {
        let dir = std::env::temp_dir().join(format!("k95-staged-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("app/daemon/dist")).unwrap();
        assert_eq!(staged(Some(&dir)), None);
        assert_eq!(staged(None), None);
        let script = dir.join("app/daemon/dist/server.js");
        std::fs::write(&script, "").unwrap();
        assert_eq!(staged(Some(&dir)), Some(script));
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(staged(exe_dir().as_deref()), None, "a test runs as dev");
    }

    #[test]
    fn the_installed_app_checks_at_start_and_after_a_restart_and_otherwise_at_most_hourly() {
        let (host, seen) = host_of(true, |repo, n| match (repo, n) {
            ("k95-a", _) => up(41001, &format!("echo KANBAN95 check=k95-a{THEN}echo KANBAN95 open=k95-b{THEN}")),
            (_, 1) => format!("echo KANBAN95 port=41002{THEN}echo KANBAN95 check=k95-b{THEN}exit 75"),
            _ => up(41003, &format!("echo KANBAN95 check=k95-b{THEN}echo KANBAN95 checknow=k95-b{THEN}echo KANBAN95 update=k95-b{THEN}")),
        });
        host.first("k95-a", host.start("k95-a").unwrap());
        until("the restarted board's update lines", || {
            host.tick();
            updates(&seen).len() == 4
        });
        assert_eq!(updates(&seen), [(41001, "auto"), (41003, "auto"), (41003, "now"), (41003, "install")]);
        host.shutdown();
    }

    #[test]
    fn dev_never_checks_and_says_so_to_check_for_updates() {
        let (host, seen) = host(|_, _| up(41001, &format!("echo KANBAN95 check=k95-a{THEN}echo KANBAN95 checknow=k95-a{THEN}echo KANBAN95 open=k95-a{THEN}")));
        host.first("k95-a", host.start("k95-a").unwrap());
        until("the board's last line", || shown(&seen).len() == 1);
        assert_eq!(updates(&seen), [(41001, "dev")]);
        host.shutdown();
    }

    #[test]
    fn a_failed_check_is_one_stderr_line_and_reaches_the_ui_only_when_asked_for() {
        let offline = Err("error sending request".to_string());
        assert_eq!(outcome(&offline, "0.1.0", false), ("[shell] update check failed: error sending request".into(), None));
        let (_, told) = outcome(&offline, "0.1.0", true);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&told.unwrap()).unwrap()["state"], "failed");
        assert_eq!(outcome(&Ok(None), "0.1.0", false).1, None);
        assert_eq!(outcome(&Ok(None), "0.1.0", true).1.unwrap(), r#"{"current":"0.1.0","state":"current"}"#);
        for manual in [false, true] {
            assert_eq!(outcome(&Ok(Some("0.2.0".into())), "0.1.0", manual).1.unwrap(), r#"{"current":"0.1.0","state":"available","version":"0.2.0"}"#);
        }
    }

    #[test]
    fn the_update_url_override_is_https_or_http_on_loopback() {
        assert_eq!(endpoint(None), Ok(None));
        for ok in ["https://example.com/latest.json", "http://127.0.0.1:8123/latest.json"] {
            assert_eq!(endpoint(Some(ok.into())), Ok(Some(ok.parse().unwrap())), "{ok}");
        }
        for bad in ["http://example.com/latest.json", "http://localhost:8123/latest.json", "file:///C:/latest.json", "latest.json"] {
            assert!(endpoint(Some(bad.into())).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_report_reaches_the_daemon_with_its_secret_and_no_origin() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req = String::new();
            let mut buf = [0u8; 1024];
            while !req.contains(r#""state":"installing"}"#) {
                let n = s.read(&mut buf).unwrap();
                req.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
            s.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();
            req
        });
        tell(&Daemon { port, secret: "s3cret".into() }, r#"{"state":"installing"}"#);
        let req = server.join().unwrap();
        assert!(req.starts_with("POST /api/update/shell HTTP/1.1\r\n"), "{req}");
        assert!(req.contains(&format!("Host: 127.0.0.1:{port}\r\n")) && req.contains("Cookie: k95=s3cret\r\n"), "{req}");
        assert!(!req.to_lowercase().contains("origin:"), "{req}");
    }

    fn with_updater() -> tauri::App<tauri::test::MockRuntime> {
        let mut ctx = tauri::generate_context!(test = true);
        let bundle: serde_json::Value = serde_json::from_str(include_str!("../tauri.bundle.json")).unwrap();
        ctx.config_mut().plugins.0.insert("updater".into(), bundle["plugins"]["updater"].clone());
        mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).manage(Pending::default()).build(ctx).unwrap()
    }

    fn serve(listener: std::net::TcpListener, reply: String) {
        use std::io::{Read, Write};
        std::thread::spawn(move || {
            for mut s in listener.incoming().map_while(Result::ok) {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let _ = s.write_all(reply.as_bytes());
            }
        });
    }

    #[test]
    fn the_real_check_reports_a_newer_release_from_a_local_manifest_and_an_unreachable_one_to_nobody() {
        use std::io::Read;
        let app = with_updater();
        let manifest = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}/latest.json", manifest.local_addr().unwrap().port());
        let entry = serde_json::json!({ "url": "http://127.0.0.1:9/Kanban95_9.9.9_x64-setup.exe", "signature": "unsigned" });
        let platforms: serde_json::Map<_, _> = ["windows-x86_64", "windows-aarch64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"].iter().map(|p| (p.to_string(), entry.clone())).collect();
        let body = serde_json::json!({ "version": "9.9.9", "notes": "", "pub_date": "2026-10-01T00:00:00Z", "platforms": platforms }).to_string();
        serve(manifest, format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
        let daemon = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let to = Daemon { port: daemon.local_addr().unwrap().port(), secret: "s".into() };

        std::env::set_var(UPDATE_URL, &url);
        let told = std::thread::spawn(move || {
            let (mut s, _) = daemon.accept().unwrap();
            let mut req = String::new();
            let mut buf = [0u8; 4096];
            while !req.ends_with('}') {
                let n = s.read(&mut buf).unwrap();
                req.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
            std::io::Write::write_all(&mut s, b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();
            (req, daemon)
        });
        check(app.handle().clone(), to.clone(), false);
        let (req, daemon) = told.join().unwrap();
        let current = app.package_info().version.to_string();
        assert!(req.ends_with(&format!(r#"{{"current":"{current}","state":"available","version":"9.9.9"}}"#)), "{req}");
        assert_eq!(lock(&app.state::<Pending>().0).as_ref().map(|u| u.version.clone()), Some("9.9.9".into()));

        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        std::env::set_var(UPDATE_URL, format!("http://127.0.0.1:{}/latest.json", closed.local_addr().unwrap().port()));
        drop(closed);
        let scratch = std::env::temp_dir().join(format!("k95-update-check-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&scratch);
        std::env::set_var("KANBAN95_SHELL_LOG", &scratch);
        check(app.handle().clone(), to, false);
        std::env::remove_var("KANBAN95_SHELL_LOG");
        std::env::remove_var(UPDATE_URL);
        let logged = std::fs::read_to_string(&scratch).unwrap_or_default();
        let _ = std::fs::remove_file(&scratch);
        assert!(logged.contains("update check failed"), "{logged}");
        daemon.set_nonblocking(true).unwrap();
        assert!(daemon.accept().is_err(), "a failed automatic check tells the daemon nothing");
    }

    #[cfg(windows)]
    #[test]
    fn a_process_started_after_the_breakaway_is_outside_the_kill_on_close_job() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        kill_children_with_us();
        let job = *JOB.get().expect("the job") as windows_sys::Win32::Foundation::HANDLE;
        let start = || Command::new("cmd").args(["/d", "/c", WAIT]).stdin(Stdio::piped()).spawn().unwrap();
        let inside = |c: &Child| {
            let mut r = 0;
            unsafe { IsProcessInJob(c.as_raw_handle() as _, job, &mut r) };
            r != 0
        };
        let mut before = start();
        let_installer_outlive_us();
        let mut after = start();
        let (was, is) = (inside(&before), inside(&after));
        for c in [&mut before, &mut after] {
            drop(c.stdin.take());
            let _ = c.kill();
            let _ = c.wait();
        }
        assert!(was, "a child started before is in the job");
        assert!(!is, "a child started after is not");
    }

    #[test]
    fn a_login_path_is_added_after_the_path_the_app_got() {
        assert_eq!(merge_path("/fnm/node24/bin:/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin:/usr/local/bin"), "/fnm/node24/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
        assert_eq!(merge_path("/usr/bin:/bin", ""), "/usr/bin:/bin");
        assert_eq!(merge_path("", "/opt/homebrew/bin::/usr/bin"), "/opt/homebrew/bin:/usr/bin");
    }

    #[test]
    fn the_bundled_node_next_to_the_exe_is_run_and_path_node_only_without_it() {
        let dir = std::env::temp_dir().join(format!("k95-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(node_exe(Some(&dir)), std::path::PathBuf::from("node"));
        assert_eq!(node_exe(None), std::path::PathBuf::from("node"));
        let bundled = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::write(&bundled, "").unwrap();
        assert_eq!(node_exe(Some(&dir)), bundled);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    const PAUSE: &str = "ping -n 2 127.0.0.1 >nul&";
    #[cfg(not(windows))]
    const PAUSE: &str = "sleep 1;";

    #[test]
    fn the_splash_shows_only_after_400_ms_and_goes_after_the_board_is_shown_or_before_the_error() {
        let boot = |line: String| {
            let (host, seen) = host(|_, _| unreachable!());
            let ok = host.boot("k95-a".into(), spawn(stand_in(line)).unwrap(), Instant::now());
            if ok {
                assert!(!lock(&seen).iter().any(|f| matches!(f, Effect::Show { .. } | Effect::Splash(false))), "no show before the page loaded");
                assert!(host.tick());
                assert!(!lock(&seen).iter().any(|f| matches!(f, Effect::Show { .. } | Effect::Splash(false))), "no show before the page loaded");
                host.loaded(&label("k95-a"));
            }
            let fx: Vec<String> = std::mem::take(&mut *lock(&seen))
                .into_iter()
                .map(|f| match f {
                    Effect::Open { label: l, .. } => format!("open {}", if l == label("k95-a") { "a" } else { "?" }),
                    Effect::Show { like: None, .. } => "show".into(),
                    Effect::Splash(on) => format!("splash {on}"),
                    Effect::Error(_) => "error".into(),
                    Effect::Exit(code) => format!("exit {code}"),
                    f => format!("{f:?}"),
                })
                .collect();
            let hosted = hosted(&host).len();
            host.shutdown();
            (ok, hosted, fx)
        };
        let (ok, hosted, fx) = boot(up(41501, ""));
        assert!(ok && hosted == 1);
        assert_eq!(fx, ["open a", "show"]);
        let (ok, hosted, fx) = boot(format!("{PAUSE}{}", up(41502, "")));
        assert!(ok && hosted == 1);
        assert_eq!(fx, ["splash true", "open a", "show", "splash false"]);
        let (ok, hosted, fx) = boot("echo nope".into());
        assert!(!ok && hosted == 0);
        assert_eq!(fx, ["error", "exit 1"]);
        let (ok, hosted, fx) = boot(format!("{PAUSE}echo nope"));
        assert!(!ok && hosted == 0);
        assert_eq!(fx, ["splash true", "splash false", "error", "exit 1"]);
    }

    #[test]
    fn a_new_board_is_shown_only_once_its_page_loaded_and_a_board_that_never_loads_after_the_fallback() {
        let (host, seen) = host(|repo, _| up(41000 + repo.len() as u16, ""));
        host.first("k95-a", host.start("k95-a").unwrap());
        host.command(Verb::Open, "k95-bb", None);
        until("the second board", || hosted(&host).len() == 2);
        assert!(host.tick());
        let fx = take(&seen);
        assert!(matches!(&fx[..], [Effect::Open { label: b, .. }] if *b == label("k95-bb")), "{fx:?}");
        assert_eq!(lock(&host.table).main, "k95-a");
        host.command(Verb::Switch, "k95-bb", None);
        host.loaded(&label("k95-a"));
        assert!(take(&seen).is_empty(), "a switch to it or another board's load shows nothing");
        host.loaded(&label("k95-bb"));
        assert_eq!(take(&seen), [show("k95-bb", Some("k95-a")), Effect::Hide(label("k95-a"))]);
        assert_eq!(lock(&host.table).main, "k95-bb");
        host.loaded(&label("k95-bb"));
        assert!(take(&seen).is_empty(), "a later load of a shown board changes nothing");

        let began = Instant::now();
        host.command(Verb::Open, "k95-ccc", None);
        until("the third board", || hosted(&host).len() == 3);
        let end = began + SHOW_WAIT + Duration::from_secs(5);
        while shown(&seen).is_empty() {
            assert!(Instant::now() < end, "not shown within the fallback");
            assert!(host.tick());
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(began.elapsed() >= SHOW_WAIT, "shown before the fallback: {:?}", began.elapsed());
        assert_eq!(take(&seen)[1..], [show("k95-ccc", Some("k95-bb")), Effect::Hide(label("k95-bb"))]);
        assert_eq!(lock(&host.table).main, "k95-ccc");
        host.shutdown();
    }

    #[test]
    fn closing_a_board_still_waiting_to_be_shown_drops_its_show_and_keeps_main() {
        let (host, seen) = host(|repo, _| up(41000 + repo.len() as u16, ""));
        host.first("k95-a", host.start("k95-a").unwrap());
        host.command(Verb::Open, "k95-bb", None);
        until("the second board", || hosted(&host).len() == 2);
        take(&seen);
        host.command(Verb::Close, "k95-bb", None);
        host.loaded(&label("k95-bb"));
        assert!(host.tick());
        assert_eq!(take(&seen), [Effect::Close(label("k95-bb"))]);
        assert_eq!((hosted(&host), lock(&host.table).main.clone()), (vec![("k95-a".into(), Place::Docked)], "k95-a".into()));
        host.shutdown();
    }

    #[test]
    fn a_failed_handshake_logs_one_line_with_its_error_and_a_good_start_logs_nothing() {
        let file = std::env::temp_dir().join(format!("kanban95-shell-log-test-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&file);
        let boot = |line: String| {
            let host = Host::new(|_| unreachable!(), false, Some(file.clone()));
            let ok = host.boot("k95-a".into(), spawn(stand_in(line)).unwrap(), Instant::now());
            host.shutdown();
            ok
        };
        assert!(boot(up(41511, "")));
        assert!(!file.exists());
        assert!(!boot("echo nope".into()));
        let logged = std::fs::read_to_string(&file).unwrap();
        let _ = std::fs::remove_file(&file);
        let lines: Vec<_> = logged.lines().collect();
        assert!(matches!(&lines[..], [l] if l.contains("The Kanban95 daemon did not start (it said \"nope\").") && l.contains("npm run build")), "{logged:?}");
        assert!(lines[0].as_bytes()[10] == b'T' && lines[0][21..].starts_with("The Kanban95"), "{logged:?}");
    }

    #[test]
    fn log_times_are_utc_iso_dates() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(951_782_400 + 86_399), "2000-02-29T23:59:59Z");
        assert_eq!(iso(1_791_849_600), "2026-10-13T00:00:00Z");
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
    fn the_splash_page_and_icon_are_served_typed_and_its_lock_lets_its_own_url_load() {
        let page = splash_response("/");
        assert_eq!(page.status(), 200);
        assert_eq!(page.headers()["Content-Type"], "text/html");
        let html = std::str::from_utf8(page.body()).unwrap();
        assert!(html.contains("<style>") && html.contains("background: #c0c0c0") && html.contains(r#"<img src="icon.png""#));
        let icon = splash_response("/icon.png");
        assert_eq!((icon.status().as_u16(), icon.headers()["Content-Type"].to_str().unwrap()), (200, "image/png"));
        assert!(icon.body().starts_with(b"\x89PNG"));
        assert_eq!(splash_response("/x").status(), 404);
        let home = splash_url();
        assert!(on_splash(&home) && on_splash(&home.join("icon.png").unwrap()));
        assert!(!on_splash(&"https://example.com/".parse().unwrap()) && !on_splash(&"k95splash://evil/".parse().unwrap()));
        assert!(!on_splash(&"http://127.0.0.1:41234/".parse().unwrap()));
    }

    #[test]
    fn only_https_new_windows_go_to_the_system_browser() {
        let ext = |u: &str| external(&u.parse().unwrap());
        assert!(ext("https://github.com/dillon-shearer/Kanban95/actions"));
        assert!(!ext("http://example.com/") && !ext("http://127.0.0.1:41234/") && !ext("file:///C:/Windows/notepad.exe"));
        assert!(!ext("javascript:alert(1)") && !ext("ms-settings:") && !ext("data:text/html,x"));
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
        let app = with_updater();
        let origin: tauri::Url = "http://127.0.0.1:41234/".parse().unwrap();
        let w = window(&app, &label("k95-a"), origin.clone(), "Kanban95".into(), Arc::new(Mutex::new(vec![41234]))).unwrap();
        for cmd in [
            "plugin:app|version",
            "plugin:window|close",
            "plugin:webview|create_webview_window",
            "plugin:event|emit",
            "plugin:path|resolve_directory",
            "plugin:updater|check",
            "plugin:updater|download_and_install",
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
