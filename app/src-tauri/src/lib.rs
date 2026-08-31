//! Tauri shell: thin command layer over slideshow-core. The frontend owns the
//! project document; this side renders previews/exports and touches the disk.

mod preview;

use anyhow::Context;
use serde::Serialize;
use slideshow_core::export::{CancelFlag, ExportOptions};
use slideshow_core::{Ffmpeg, Project, Timeline};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
use tauri::{Emitter, Manager, State};

pub struct AppState {
    ffmpeg: Option<Ffmpeg>,
    /// Latest project + timeline as posted by the frontend (shared with the
    /// preview render thread).
    current: Arc<Mutex<Option<preview::CurrentDoc>>>,
    preview_tx: crossbeam_channel_like::Sender<preview::Job>,
    export_cancel: Mutex<Option<CancelFlag>>,
    fonts: Mutex<Option<Vec<String>>>,
}

/// Tiny stand-in for a channel crate: std mpsc wrapped for Sync cloning.
mod crossbeam_channel_like {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};

    pub struct Sender<T>(Arc<Mutex<mpsc::Sender<T>>>);
    impl<T> Clone for Sender<T> {
        fn clone(&self) -> Self {
            Sender(self.0.clone())
        }
    }
    impl<T> Sender<T> {
        pub fn send(&self, v: T) {
            let _ = self.0.lock().unwrap().send(v);
        }
    }
    pub fn channel<T>() -> (Sender<T>, mpsc::Receiver<T>) {
        let (tx, rx) = mpsc::channel();
        (Sender(Arc::new(Mutex::new(tx))), rx)
    }
}

#[derive(Serialize)]
struct FfmpegStatus {
    found: bool,
    path: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct Timing {
    total: f64,
    spans: Vec<Span>,
}

#[derive(Serialize)]
struct Span {
    start: f64,
    end: f64,
    transition_in: f64,
}

#[derive(Serialize)]
struct ImportedMedia {
    path: String,
    info: slideshow_core::MediaInfo,
}

fn timing_of(project: &Project) -> Timing {
    let tl = Timeline::new(project);
    let spans = (0..tl.num_slides())
        .map(|i| Span {
            start: tl.slide_start(i),
            end: tl.slide_end(i),
            transition_in: tl.transition_in(i),
        })
        .collect();
    Timing { total: tl.total_duration(), spans }
}

#[tauri::command]
fn check_ffmpeg(state: State<AppState>) -> FfmpegStatus {
    match &state.ffmpeg {
        Some(f) => FfmpegStatus {
            found: true,
            path: Some(f.ffmpeg.display().to_string()),
            error: None,
        },
        None => FfmpegStatus {
            found: false,
            path: None,
            error: Some(
                "ffmpeg was not found. Install it on your PATH or run scripts/fetch-ffmpeg."
                    .to_string(),
            ),
        },
    }
}

/// Store the latest project; preview frames render (and cache) against this
/// revision.
#[tauri::command]
fn set_project(state: State<AppState>, project: Project, rev: u64) -> Timing {
    let timing = timing_of(&project);
    let timeline = Timeline::new(&project);
    *state.current.lock().unwrap() = Some(preview::CurrentDoc {
        project: Arc::new(project),
        timeline: Arc::new(timeline),
        rev,
    });
    timing
}

/// Project file passed on the command line (open-on-launch / double-click).
#[tauri::command]
fn startup_project() -> Option<String> {
    std::env::args().nth(1).filter(|a| a.ends_with(".json"))
}

#[tauri::command]
fn load_project(path: String) -> Result<Project, String> {
    let p = PathBuf::from(&path);
    let json = std::fs::read_to_string(&p).map_err(|e| format!("reading {path}: {e}"))?;
    let mut project = Project::from_json(&json).map_err(|e| e.to_string())?;
    if let Some(dir) = p.parent() {
        project.resolve_paths(dir);
    }
    Ok(project)
}

#[tauri::command]
fn save_project(path: String, project: Project) -> Result<(), String> {
    std::fs::write(&path, project.to_json()).map_err(|e| format!("writing {path}: {e}"))
}

#[tauri::command]
fn probe_media(state: State<AppState>, path: String) -> Result<ImportedMedia, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("{path} is not a file"));
    }
    let ffmpeg = state.ffmpeg.clone();
    let info = probe_any(&p, ffmpeg.as_ref()).map_err(|e| format!("{e:#}"))?;
    Ok(ImportedMedia { path, info })
}

/// Thumbnail as raw PNG bytes. `is_image`/`duration` come from a prior
/// `probe_media` so this never re-probes the file.
#[tauri::command]
async fn media_thumb(
    state: State<'_, AppState>,
    path: String,
    is_image: bool,
    duration: f64,
) -> Result<Response, String> {
    let ffmpeg = state.ffmpeg.clone();
    tauri::async_runtime::spawn_blocking(move || {
        make_thumb(Path::new(&path), is_image, duration, ffmpeg.as_ref())
            .map(Response::new)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn probe_any(path: &Path, ffmpeg: Option<&Ffmpeg>) -> anyhow::Result<slideshow_core::MediaInfo> {
    let image_exts = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff"];
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if image_exts.contains(&ext.as_str()) {
        let (w, h) = image::image_dimensions(path)?;
        return Ok(slideshow_core::MediaInfo {
            width: w,
            height: h,
            is_image: true,
            ..Default::default()
        });
    }
    let ffmpeg = ffmpeg.context("ffmpeg is required to inspect audio/video files")?;
    ffmpeg.probe(path)
}

fn make_thumb(
    path: &Path,
    is_image: bool,
    duration: f64,
    ffmpeg: Option<&Ffmpeg>,
) -> anyhow::Result<Vec<u8>> {
    if is_image {
        let img = image::open(path)?;
        let thumb = img.thumbnail(240, 240);
        let mut buf = std::io::Cursor::new(Vec::new());
        thumb.to_rgba8().write_to(&mut buf, image::ImageFormat::Png)?;
        Ok(buf.into_inner())
    } else {
        let ffmpeg = ffmpeg.context("ffmpeg needed for video thumbnail")?;
        let at = (duration * 0.1).clamp(0.0, 5.0);
        let out = Command::new(&ffmpeg.ffmpeg)
            .args(["-v", "error", "-ss", &format!("{at:.2}")])
            .arg("-i")
            .arg(path)
            .args(["-frames:v", "1", "-vf", "scale=240:-1", "-f", "image2pipe", "-c:v", "png", "-"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()?;
        anyhow::ensure!(out.status.success() && !out.stdout.is_empty(), "thumbnail failed");
        Ok(out.stdout)
    }
}

/// Render a preview frame (same compositor as export). Raw bytes: 8-byte
/// header (width u32 LE, height u32 LE) + straight-alpha RGBA.
#[tauri::command]
async fn render_preview(
    state: State<'_, AppState>,
    time: f64,
    scale: f32,
) -> Result<Response, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    state.preview_tx.send(preview::Job { time, scale, reply: tx });
    let bytes = tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new((*bytes).clone()))
}

#[tauri::command]
fn list_fonts(state: State<AppState>) -> Vec<String> {
    let mut cached = state.fonts.lock().unwrap();
    if cached.is_none() {
        *cached = Some(slideshow_core::text::TextRenderer::new().font_families());
    }
    cached.clone().unwrap()
}

#[derive(Clone, Serialize)]
struct ExportProgress {
    done: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct ExportDone {
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    path: Option<String>,
}

#[tauri::command]
fn export_video(
    app: tauri::AppHandle,
    state: State<AppState>,
    project: Project,
    out_path: String,
    scale: f32,
    crf: u8,
) -> Result<(), String> {
    let mut guard = state.export_cancel.lock().unwrap();
    if guard.is_some() {
        return Err("an export is already running".into());
    }
    let cancel: CancelFlag = Arc::new(AtomicBool::new(false));
    *guard = Some(cancel.clone());
    drop(guard);

    let ffmpeg = state.ffmpeg.clone();
    std::thread::spawn(move || {
        let result = (|| -> anyhow::Result<bool> {
            let ffmpeg = ffmpeg.context("ffmpeg not found — cannot export")?;
            let mut renderer = slideshow_core::Renderer::new(Some(ffmpeg));
            let options = ExportOptions { scale, crf, ..Default::default() };
            let app2 = app.clone();
            let mut last_emit = std::time::Instant::now();
            slideshow_core::export::export(
                &project,
                &mut renderer,
                Path::new(&out_path),
                &options,
                cancel.clone(),
                move |done, total| {
                    // Throttle events; the UI doesn't need every frame.
                    if done == total || last_emit.elapsed().as_millis() > 80 {
                        last_emit = std::time::Instant::now();
                        let _ = app2.emit("export:progress", ExportProgress { done, total });
                    }
                },
            )
        })();
        let payload = match result {
            Ok(true) => ExportDone { ok: true, cancelled: false, error: None, path: Some(out_path) },
            Ok(false) => ExportDone { ok: false, cancelled: true, error: None, path: None },
            Err(e) => ExportDone {
                ok: false,
                cancelled: false,
                error: Some(format!("{e:#}")),
                path: None,
            },
        };
        let state = app.state::<AppState>();
        *state.export_cancel.lock().unwrap() = None;
        let _ = app.emit("export:done", payload);
    });
    Ok(())
}

#[tauri::command]
fn cancel_export(state: State<AppState>) {
    if let Some(cancel) = state.export_cancel.lock().unwrap().as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let dir = if p.is_dir() { p.clone() } else { p.parent().map(|d| d.to_path_buf()).unwrap_or(p) };
    #[cfg(target_os = "macos")]
    let cmd = ("open", vec![dir]);
    #[cfg(target_os = "windows")]
    let cmd = ("explorer", vec![dir]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = ("xdg-open", vec![dir]);
    Command::new(cmd.0)
        .args(&cmd.1)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    let ffmpeg = Ffmpeg::locate().ok();
    if ffmpeg.is_none() {
        log::warn!("ffmpeg not found at startup");
    }

    let current: Arc<Mutex<Option<preview::CurrentDoc>>> = Arc::new(Mutex::new(None));
    let (tx, rx) = crossbeam_channel_like::channel::<preview::Job>();
    preview::spawn_render_thread(rx, current.clone(), ffmpeg.clone());

    let state = AppState {
        ffmpeg,
        current,
        preview_tx: tx,
        export_cancel: Mutex::new(None),
        fonts: Mutex::new(None),
    };

    // `mut` is only taken by the optional MCP plugin registration below.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // Opt-in via the `mcp` cargo feature (`npm run dev:mcp`). Without it the
    // crate is not in the dependency graph at all, so nothing to strip later.
    #[cfg(feature = "mcp")]
    {
        builder = builder
            .plugin(tauri_plugin_mcp::init_with_config(
                tauri_plugin_mcp::PluginConfig::new("Slideshow Studio".to_string())
                    .start_socket_server(true)
                    .socket_path("/tmp/slideshow-studio-mcp.sock".into()),
            ))
            // The capability is granted here rather than from `capabilities/`,
            // which tauri-build scans unconditionally -- `mcp:default` does not
            // exist when the feature is off, and a stale file would fail the build.
            .setup(|app| {
                use tauri::Manager;
                app.add_capability(include_str!("../mcp-capability.json"))?;
                Ok(())
            });
    }

    builder
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            startup_project,
            set_project,
            load_project,
            save_project,
            probe_media,
            media_thumb,
            list_fonts,
            render_preview,
            export_video,
            cancel_export,
            reveal_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
