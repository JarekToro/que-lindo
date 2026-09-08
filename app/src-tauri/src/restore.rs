//! Photo restoration: lifecycle of the optional Python engine in
//! `tools/restore` (spandrel models, PMRF, Bringing Old Photos Back to Life).
//!
//! The engine is a small FastAPI server. This side only finds it, starts it
//! on a free localhost port when the Restore view first opens, and stops it
//! when the app exits; the webview talks HTTP to it directly (images are
//! served straight from disk and the result cache, never through IPC).
//!
//! Where it looks, in order: `SLIDESHOW_RESTORE_DIR`, `<app data>/restore`,
//! and in debug builds the repository's `tools/restore`. A folder counts when
//! it holds `server.py` and a `.venv` (see `tools/restore/setup.sh`).

use serde::Serialize;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

pub struct RestoreState {
    running: Mutex<Option<Running>>,
}

struct Running {
    child: Child,
    port: u16,
}

impl Default for RestoreState {
    fn default() -> Self {
        RestoreState { running: Mutex::new(None) }
    }
}

#[derive(Serialize)]
pub struct RestoreStatus {
    /// The engine is installed somewhere we can start it from.
    available: bool,
    /// Folder that was used (or the first place looked when unavailable).
    dir: String,
    /// Base URL while the server process is alive.
    url: Option<String>,
    /// Where the server's stdout/stderr goes.
    log: String,
}

fn python_in(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        dir.join(".venv").join("bin").join("python")
    }
}

fn is_tool_dir(dir: &Path) -> bool {
    dir.join("server.py").is_file() && python_in(dir).is_file()
}

/// Candidate folders, most specific first.
fn candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("SLIDESHOW_RESTORE_DIR") {
        out.push(PathBuf::from(p));
    }
    if let Ok(d) = app.path().app_data_dir() {
        out.push(d.join("restore"));
    }
    if cfg!(debug_assertions) {
        out.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/restore"));
    }
    out
}

fn tool_dir(app: &tauri::AppHandle) -> Result<PathBuf, PathBuf> {
    let cands = candidates(app);
    match cands.iter().find(|d| is_tool_dir(d)) {
        Some(d) => Ok(d.canonicalize().unwrap_or_else(|_| d.clone())),
        None => Err(cands.into_iter().next().unwrap_or_else(|| PathBuf::from("tools/restore"))),
    }
}

fn log_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("restore-server.log"))
        .unwrap_or_else(|_| std::env::temp_dir().join("que-lindo-restore-server.log"))
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Ask the process to exit the way a Ctrl-C would, so uvicorn shuts down and
/// Python's atexit hooks stop the PMRF worker it may have spawned. SIGKILL
/// would strand that worker (it also watches for an orphaned parent, as a
/// second line of defence).
fn terminate(mut child: Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
        for _ in 0..50 {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl RestoreState {
    /// Stop the server if it is running (app exit).
    pub fn shutdown(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            terminate(r.child);
        }
    }
}

fn alive(running: &mut Option<Running>) -> Option<u16> {
    let r = running.as_mut()?;
    match r.child.try_wait() {
        Ok(None) => Some(r.port),
        _ => {
            running.take();
            None
        }
    }
}

#[tauri::command]
pub fn restore_status(app: tauri::AppHandle, state: tauri::State<RestoreState>) -> RestoreStatus {
    let port = alive(&mut state.running.lock().unwrap());
    let (available, dir) = match tool_dir(&app) {
        Ok(d) => (true, d),
        Err(d) => (false, d),
    };
    RestoreStatus {
        available,
        dir: dir.display().to_string(),
        url: port.map(url_for),
        log: log_path(&app).display().to_string(),
    }
}

/// Start the engine (or return the running one) and hand back its base URL.
/// Returns as soon as the process is up; the frontend polls `/api/info` for
/// readiness (importing torch takes a few seconds) and `restore_alive` to
/// notice an early death.
#[tauri::command]
pub fn restore_start(app: tauri::AppHandle, state: tauri::State<RestoreState>) -> Result<String, String> {
    let mut running = state.running.lock().unwrap();
    if let Some(port) = alive(&mut running) {
        return Ok(url_for(port));
    }
    let dir = tool_dir(&app).map_err(|looked| {
        format!(
            "the restore engine is not installed (looked in {}). Run tools/restore/setup.sh, or point SLIDESHOW_RESTORE_DIR at it.",
            looked.display()
        )
    })?;
    let port = free_port()?;
    let pmrf_port = free_port()?;
    let log = log_path(&app);
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let logf = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map_err(|e| format!("opening {}: {e}", log.display()))?;
    let logf_err = logf.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(python_in(&dir))
        .args(["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", &port.to_string()])
        .current_dir(&dir)
        // The webview is another origin; the server is loopback-only and
        // started by us, so cross-origin is the intended caller.
        .env("RC_CORS", "1")
        // Any folder the user can pick a photo from; the default (home only)
        // would refuse external drives.
        .env("RC_ROOTS", if cfg!(windows) { "C:\\" } else { "/" })
        .env("RC_PMRF_PORT", pmrf_port.to_string())
        // A force-quit (or the e2e harness) skips RunEvent::Exit; the server
        // notices it is no longer our child and exits on its own.
        .env("RC_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(logf))
        .stderr(Stdio::from(logf_err))
        .spawn()
        .map_err(|e| format!("starting the restore engine in {}: {e}", dir.display()))?;
    log::info!("restore engine started on port {port} from {}", dir.display());
    *running = Some(Running { child, port });
    Ok(url_for(port))
}

/// Whether the server process we started is still running.
#[tauri::command]
pub fn restore_alive(state: tauri::State<RestoreState>) -> bool {
    alive(&mut state.running.lock().unwrap()).is_some()
}

#[tauri::command]
pub fn restore_stop(state: tauri::State<RestoreState>) {
    state.shutdown();
}
