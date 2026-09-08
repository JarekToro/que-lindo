//! Tauri shell: thin command layer over slideshow-core. The frontend owns the
//! project document; this side renders previews/exports and touches the disk.

mod embed;
mod focus;
mod preview;
mod restore;

use anyhow::Context;
use serde::Serialize;
use slideshow_core::export::{CancelFlag, ExportOptions};
use slideshow_core::{Ffmpeg, Project, Timeline};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
use tauri::{Emitter, Manager, State};

pub struct AppState {
    ffmpeg: Option<Ffmpeg>,
    /// Grouping features accumulated as import commands run, keyed by path.
    features: Mutex<HashMap<String, slideshow_core::grouping::MediaFeatures>>,
    /// Latest project + timeline as posted by the frontend (shared with the
    /// preview render thread).
    current: Arc<Mutex<Option<preview::CurrentDoc>>>,
    preview_tx: crossbeam_channel_like::Sender<preview::Job>,
    export_cancel: Mutex<Option<CancelFlag>>,
    fonts: Mutex<Option<Vec<String>>>,
    /// Mixed preview audio (raw PCM), keyed by a hash of what the mix
    /// actually depends on (audio tracks + film length) — photo edits bump
    /// the project rev constantly and must not throw the mix away.
    audio_mix: Mutex<Option<(u64, Arc<Vec<u8>>)>>,
    /// Paths whose cached pixels are stale (edited externally); the preview
    /// thread drains this before rendering.
    preview_invalidate: Arc<Mutex<Vec<PathBuf>>>,
    /// mtime of each file when it was handed to an external editor (or last
    /// checked) — what `changed_media` diffs against. None = unreadable then.
    edit_mtimes: Mutex<HashMap<PathBuf, Option<std::time::SystemTime>>>,
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
    /// When the file says it was shot, Unix seconds; None when nothing does.
    /// Auto-build orders the film by this.
    captured_at: Option<i64>,
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

/// Write the backend's current document (the last `set_project`) to disk —
/// a recovery path that needs nothing from the frontend.
#[tauri::command]
fn save_current_project(state: State<AppState>, path: String) -> Result<(), String> {
    let current = state.current.lock().unwrap();
    let Some(doc) = current.as_ref() else {
        return Err("no project loaded".to_string());
    };
    std::fs::write(&path, doc.project.to_json()).map_err(|e| format!("writing {path}: {e}"))
}

/// The untitled project's recovery snapshot: one well-known file, since an
/// unsaved project has no directory of its own to sit beside.
const UNTITLED_AUTOSAVE: &str = "untitled.slideshow.json.autosave";

#[derive(Serialize)]
struct AutosaveInfo {
    path: String,
    /// Snapshot mtime as Unix milliseconds.
    modified_ms: u64,
}

/// Where a project's recovery snapshot lives: beside the project file, or in
/// the app data dir when the project has never been saved.
fn autosave_target(app: &tauri::AppHandle, project_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = project_path {
        return Ok(PathBuf::from(format!("{p}.autosave")));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    Ok(dir.join(UNTITLED_AUTOSAVE))
}

fn modified_ms(meta: &std::fs::Metadata) -> Result<u64, String> {
    let t = meta.modified().map_err(|e| e.to_string())?;
    let since = t.duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?;
    Ok(since.as_millis() as u64)
}

/// Write a recovery snapshot (same JSON a manual save writes, so
/// `load_project` reads it back) and return where it landed. Omitting
/// `project` snapshots the backend's last `set_project` instead — a closing
/// window has no time to marshal the document across IPC.
#[tauri::command]
fn write_autosave(
    app: tauri::AppHandle,
    state: State<AppState>,
    project_path: Option<String>,
    project: Option<Project>,
) -> Result<String, String> {
    let target = autosave_target(&app, project_path.as_deref())?;
    let json = match project {
        Some(p) => p.to_json(),
        None => {
            let current = state.current.lock().unwrap();
            let doc = current.as_ref().ok_or_else(|| "no project loaded".to_string())?;
            doc.project.to_json()
        }
    };
    std::fs::write(&target, json).map_err(|e| format!("writing {}: {e}", target.display()))?;
    Ok(target.display().to_string())
}

#[tauri::command]
fn clear_autosave(app: tauri::AppHandle, project_path: Option<String>) -> Result<(), String> {
    let target = autosave_target(&app, project_path.as_deref())?;
    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("removing {}: {e}", target.display())),
    }
}

/// The recovery snapshot worth offering, or null when there is none: a
/// snapshot no newer than the project file it sits beside is left over from
/// before the last manual save and must not shadow it.
#[tauri::command]
fn autosave_info(
    app: tauri::AppHandle,
    project_path: Option<String>,
) -> Result<Option<AutosaveInfo>, String> {
    let target = autosave_target(&app, project_path.as_deref())?;
    let Ok(snapshot) = std::fs::metadata(&target) else {
        return Ok(None);
    };
    let modified = modified_ms(&snapshot)?;
    if let Some(p) = project_path.as_deref() {
        if let Ok(original) = std::fs::metadata(p) {
            if modified_ms(&original)? >= modified {
                return Ok(None);
            }
        }
    }
    Ok(Some(AutosaveInfo { path: target.display().to_string(), modified_ms: modified }))
}

/// Async + blocking pool so the frontend can probe several files at once
/// (its import worker pool bounds the concurrency).
#[tauri::command]
async fn probe_media(state: State<'_, AppState>, path: String) -> Result<ImportedMedia, String> {
    let ffmpeg = state.ffmpeg.clone();
    let media = tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.is_file() {
            return Err(format!("{path} is not a file"));
        }
        let info = probe_any(&p, ffmpeg.as_ref()).map_err(|e| format!("{e:#}"))?;
        let captured_at = capture_time(&p, info.is_image);
        Ok(ImportedMedia { path, info, captured_at })
    })
    .await
    .map_err(|e| e.to_string())??;
    with_features(&state, &media.path, |f| {
        f.is_image = media.info.is_image;
        f.captured_at = media.captured_at;
    });
    Ok(media)
}

/// The photo's faces (weighted centroid + padded union region) as frame
/// fractions, or null when nothing is detected — zoom defaults aim at the
/// point, Smart fit frames the region.
#[tauri::command]
async fn detect_focus(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<focus::FocusInfo>, String> {
    let path2 = path.clone();
    let det: Option<focus::FocusInfo> =
        tauri::async_runtime::spawn_blocking(move || focus::detect_focus(Path::new(&path)))
            .await
            .map_err(|e| e.to_string())?;
    // A clean run that saw nothing is real evidence: zero faces.
    with_features(&state, &path2, |f| {
        f.face_count = Some(det.as_ref().map_or(0, |d| d.count as u32));
    });
    Ok(det)
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
    let path2 = path.clone();
    let ffmpeg = state.ffmpeg.clone();
    let (thumb, signature) = tauri::async_runtime::spawn_blocking(move || {
        make_thumb(Path::new(&path), is_image, duration, ffmpeg.as_ref())
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(sig) = signature {
        with_features(&state, &path2, |f| f.signature = Some(sig));
    }
    Ok(Response::new(thumb))
}

/// The moment a file claims for itself: a photo's EXIF capture time, or a
/// clip's modification time — video containers rarely carry a shot date, and
/// an mtime at least orders a card emptied in one go. None when neither
/// answers (a photo stripped of EXIF keeps its place in the bin instead).
fn capture_time(path: &Path, is_image: bool) -> Option<i64> {
    if is_image {
        return slideshow_core::media::exif_capture_time(path);
    }
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let secs = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    i64::try_from(secs).ok()
}

#[tauri::command]
async fn embed_media(app: tauri::AppHandle, path: String) -> Result<Option<Vec<f32>>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path2 = path.clone();
    let emb = tauri::async_runtime::spawn_blocking(move || embed::embed(&dir, Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?;
    if let Some(e) = &emb {
        with_features(&app.state::<AppState>(), &path2, |f| f.embedding = Some(e.clone()));
    }
    Ok(emb)
}

#[tauri::command]
async fn face_embeddings(app: tauri::AppHandle, path: String) -> Result<Vec<Vec<f32>>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path2 = path.clone();
    let faces = tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(&path);
        let boxes = focus::face_boxes(p);
        embed::embed_faces(&dir, p, &boxes)
    })
    .await
    .map_err(|e| e.to_string())?;
    with_features(&app.state::<AppState>(), &path2, |f| f.faces = faces.clone());
    Ok(faces)
}

/// Order-independent moment discovery over already-imported media: clusters
/// come back as path lists, using whatever features the import pipeline has
/// cached for each path.
#[tauri::command]
fn group_moments(state: State<'_, AppState>, paths: Vec<String>) -> Vec<Vec<String>> {
    let map = state.features.lock().unwrap();
    let items: Vec<slideshow_core::grouping::MediaFeatures> = paths
        .iter()
        .map(|p| map.get(p).cloned().unwrap_or_default())
        .collect();
    drop(map);
    slideshow_core::grouping::group_moments(&items, &paths)
        .into_iter()
        .map(|c| c.into_iter().map(|i| paths[i].clone()).collect())
        .collect()
}

/// Write the whole feature cache to a JSON file (calibration harnesses read
/// it; too big to ship over IPC).
#[tauri::command]
fn dump_grouping_features(state: State<'_, AppState>, out: String) -> Result<usize, String> {
    let map = state.features.lock().unwrap();
    let obj: HashMap<&String, serde_json::Value> = map
        .iter()
        .map(|(k, f)| {
            (
                k,
                serde_json::json!({
                    "is_image": f.is_image,
                    "captured_at": f.captured_at,
                    "embedding": f.embedding,
                    "faces": f.faces,
                    "signature": f.signature,
                    "face_count": f.face_count,
                }),
            )
        })
        .collect();
    std::fs::write(&out, serde_json::to_vec(&obj).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(obj.len())
}

#[tauri::command]
fn embed_available(app: tauri::AppHandle) -> bool {
    app.path()
        .app_data_dir()
        .map(|d| embed::available(&d))
        .unwrap_or(false)
}

fn with_features(
    state: &AppState,
    path: &str,
    f: impl FnOnce(&mut slideshow_core::grouping::MediaFeatures),
) {
    let mut map = state.features.lock().unwrap();
    f(map.entry(path.to_string()).or_default());
}

/// 6x6 mean-RGB fingerprint over the decoded image — the grouping signal
/// that survives when metadata doesn't.
fn image_signature(img: &image::DynamicImage) -> Vec<u8> {
    let rgb = img.thumbnail(240, 240).into_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let mut sig = Vec::with_capacity(108);
    for by in 0..6 {
        let y0 = by * h / 6;
        let y1 = ((by + 1) * h / 6).max(y0 + 1);
        for bx in 0..6 {
            let x0 = bx * w / 6;
            let x1 = ((bx + 1) * w / 6).max(x0 + 1);
            let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
            for y in y0..y1 {
                for x in x0..x1 {
                    let px = rgb.get_pixel(x as u32, y as u32);
                    r += u64::from(px.0[0]);
                    g += u64::from(px.0[1]);
                    b += u64::from(px.0[2]);
                    n += 1;
                }
            }
            sig.push((r / n) as u8);
            sig.push((g / n) as u8);
            sig.push((b / n) as u8);
        }
    }
    sig
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
) -> anyhow::Result<(Vec<u8>, Option<Vec<u8>>)> {
    if is_image {
        let img = image::open(path)?;
        let signature = image_signature(&img);
        let thumb = img.thumbnail(240, 240);
        let mut buf = std::io::Cursor::new(Vec::new());
        thumb.to_rgba8().write_to(&mut buf, image::ImageFormat::Png)?;
        Ok((buf.into_inner(), Some(signature)))
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
        Ok((out.stdout, None))
    }
}

/// Render a preview frame (same compositor as export). Raw bytes: 8-byte
/// header (width u32 LE, height u32 LE) + straight-alpha RGBA.
#[tauri::command]
async fn render_preview(
    state: State<'_, AppState>,
    time: f64,
    scale: f32,
    reveal_texts: bool,
    min_rev: u64,
) -> Result<Response, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    state.preview_tx.send(preview::Job { time, scale, reveal_texts, min_rev, reply: tx });
    let bytes = tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new((*bytes).clone()))
}

/// Mixed preview audio, prefixed with the project revision it was rendered
/// from (u64 LE) so the frontend can detect a stale answer — its request may
/// race the debounced `set_project`. Body: raw interleaved s16le stereo PCM
/// at 48 kHz; header only = the project has no audible audio.
#[tauri::command]
async fn render_audio_mix(state: State<'_, AppState>) -> Result<Response, String> {
    let doc = state
        .current
        .lock()
        .unwrap()
        .as_ref()
        .map(|d| (d.project.clone(), d.timeline.clone(), d.rev));
    let Some((project, timeline, rev)) = doc else {
        return Err("no project loaded".to_string());
    };
    let respond = |rev: u64, pcm: &[u8]| {
        let mut out = Vec::with_capacity(8 + pcm.len());
        out.extend_from_slice(&rev.to_le_bytes());
        out.extend_from_slice(pcm);
        Response::new(out)
    };
    // The mix depends only on the audio tracks and the film's length; hash
    // those so photo edits reuse the rendered PCM instead of re-decoding
    // whole songs on every revision.
    let mix_key = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        serde_json::to_string(&project.audio).unwrap_or_default().hash(&mut h);
        timeline.total_duration().to_bits().hash(&mut h);
        h.finish()
    };
    if let Some((cached_key, bytes)) = state.audio_mix.lock().unwrap().as_ref() {
        if *cached_key == mix_key {
            return Ok(respond(rev, bytes));
        }
    }
    let ffmpeg = state.ffmpeg.clone();
    let pcm = tauri::async_runtime::spawn_blocking(move || {
        let mut cache = slideshow_core::MediaCache::new(ffmpeg);
        slideshow_core::audio::render_mix_pcm(&project, &timeline, &mut cache)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    let bytes = Arc::new(pcm.unwrap_or_default());
    *state.audio_mix.lock().unwrap() = Some((mix_key, bytes.clone()));
    Ok(respond(rev, &bytes))
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

/// An application the OS lists as able to edit a given file.
#[derive(Serialize)]
struct EditorApp {
    /// Display name (bundle name without ".app").
    name: String,
    /// Filesystem path of the application, for `open_in_app`.
    path: String,
}

/// Apps registered with the OS as *editors* for this file, default editor
/// first, the rest alphabetical. Empty on platforms without such a registry
/// (the frontend then falls back to a single "default app" entry).
#[tauri::command]
fn edit_apps(path: String) -> Vec<EditorApp> {
    #[cfg(target_os = "macos")]
    return macos_apps::edit_apps(&path);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
mod macos_apps {
    //! LaunchServices lookup of which applications can edit a file. The C
    //! API is deprecated in favour of NSWorkspace, but unlike NSWorkspace it
    //! is documented thread-safe and lets us ask for the *editor* role
    //! (NSWorkspace only answers "can open").

    use super::EditorApp;
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::TCFType;
    use core_foundation::url::{CFURL, CFURLRef};
    use std::ffi::c_void;
    use std::path::Path;

    const K_LS_ROLES_EDITOR: u32 = 0x0000_0004;
    const K_LS_ROLES_ALL: u32 = 0xFFFF_FFFF;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyApplicationURLsForURL(in_url: CFURLRef, roles: u32) -> CFArrayRef;
        fn LSCopyDefaultApplicationURLForURL(
            in_url: CFURLRef,
            roles: u32,
            error: *mut *mut c_void,
        ) -> CFURLRef;
    }

    fn apps_for_role(url: &CFURL, roles: u32) -> Vec<std::path::PathBuf> {
        let arr = unsafe { LSCopyApplicationURLsForURL(url.as_concrete_TypeRef(), roles) };
        if arr.is_null() {
            return Vec::new();
        }
        let arr: CFArray<CFURL> = unsafe { CFArray::wrap_under_create_rule(arr) };
        arr.iter().filter_map(|u| u.to_path()).collect()
    }

    pub fn edit_apps(path: &str) -> Vec<EditorApp> {
        let Some(url) = CFURL::from_path(Path::new(path), false) else {
            return Vec::new();
        };
        // Editors first; fall back to anything that can open the file at all
        // (some editors only register the viewer role).
        let mut paths = apps_for_role(&url, K_LS_ROLES_EDITOR);
        if paths.is_empty() {
            paths = apps_for_role(&url, K_LS_ROLES_ALL);
        }
        let default = {
            let mut err: *mut c_void = std::ptr::null_mut();
            let u = unsafe {
                LSCopyDefaultApplicationURLForURL(
                    url.as_concrete_TypeRef(),
                    K_LS_ROLES_EDITOR,
                    &mut err,
                )
            };
            if u.is_null() {
                None
            } else {
                unsafe { CFURL::wrap_under_create_rule(u) }.to_path()
            }
        };

        let name_of = |p: &Path| {
            p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
        };
        paths.sort_by_key(|p| name_of(p).to_lowercase());
        paths.dedup();
        if let Some(d) = default {
            if let Some(at) = paths.iter().position(|p| *p == d) {
                let d = paths.remove(at);
                paths.insert(0, d);
            }
        }
        paths
            .into_iter()
            .filter(|p| !name_of(p).is_empty())
            .map(|p| EditorApp { name: name_of(&p), path: p.display().to_string() })
            .collect()
    }
}

/// Open a file in an application to edit it (`app` = path of the app, or
/// None for the OS default). Records the file's mtime so `changed_media`
/// can tell whether the editor actually saved anything.
#[tauri::command]
fn open_in_app(state: State<AppState>, path: String, app: Option<String>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let mtime = std::fs::metadata(&p).ok().and_then(|m| m.modified().ok());
    state.edit_mtimes.lock().unwrap().insert(p.clone(), mtime);
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        if let Some(a) = &app {
            cmd.arg("-a").arg(a);
        }
        cmd.arg(&p).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(&p)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = app;
        Command::new("xdg-open").arg(&p).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Of the files handed to an external editor, the ones whose bytes changed
/// since `open_in_app` (or the last check). Changed files are purged from the
/// preview caches so the next frame decodes fresh pixels; the frontend
/// refreshes their thumbnails and bumps the revision.
#[tauri::command]
fn changed_media(state: State<AppState>, paths: Vec<String>) -> Vec<String> {
    let mut mtimes = state.edit_mtimes.lock().unwrap();
    let mut changed = Vec::new();
    for path in paths {
        let p = PathBuf::from(&path);
        let now = std::fs::metadata(&p).ok().and_then(|m| m.modified().ok());
        // A path never launched from here counts as changed once: better one
        // spurious refresh than a stale frame.
        let dirty = mtimes.get(&p).map(|known| *known != now).unwrap_or(true);
        if dirty {
            mtimes.insert(p.clone(), now);
            state.preview_invalidate.lock().unwrap().push(p);
            changed.push(path);
        }
    }
    changed
}

/// How deep `search_media_folder` descends below the folder it was given.
const SEARCH_MAX_DEPTH: usize = 6;

#[derive(Serialize)]
struct FolderSearch {
    /// File name -> the path found for it.
    matches: std::collections::HashMap<String, String>,
    /// Names that turned up more than once; the shallowest match won.
    ambiguous: Vec<String>,
}

/// Of the paths given, the ones that are gone from disk — what separates a
/// moved/renamed file (relinkable) from a probe that failed for some other
/// reason (a corrupt file, a missing ffmpeg).
#[tauri::command]
fn missing_paths(paths: Vec<String>) -> Vec<String> {
    paths.into_iter().filter(|p| !Path::new(p).is_file()).collect()
}

/// Hunt a folder tree for files with the given names (relinking a whole moved
/// library at once). Breadth-first so the shallowest match wins, bounded in
/// depth, hidden directories skipped. `file_type` does not follow symlinks, so
/// linked directories are never descended into and cannot cycle.
#[tauri::command]
async fn search_media_folder(dir: String, names: Vec<String>) -> Result<FolderSearch, String> {
    use std::collections::{HashMap, HashSet, VecDeque};
    tauri::async_runtime::spawn_blocking(move || {
        let wanted: HashSet<String> = names.into_iter().collect();
        let mut matches: HashMap<String, String> = HashMap::new();
        let mut ambiguous: Vec<String> = Vec::new();
        let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(PathBuf::from(&dir), 0usize)]);
        while let Some((d, depth)) = queue.pop_front() {
            let Ok(entries) = std::fs::read_dir(&d) else { continue };
            // Sorted so a folder with several copies relinks the same way twice.
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_dir() {
                    if depth < SEARCH_MAX_DEPTH {
                        queue.push_back((entry.path(), depth + 1));
                    }
                } else if kind.is_file() && wanted.contains(&name) {
                    if matches.contains_key(&name) {
                        if !ambiguous.contains(&name) {
                            ambiguous.push(name);
                        }
                    } else {
                        matches.insert(name, entry.path().display().to_string());
                    }
                }
            }
        }
        ambiguous.sort();
        Ok(FolderSearch { matches, ambiguous })
    })
    .await
    .map_err(|e| e.to_string())?
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
    let preview_invalidate: Arc<Mutex<Vec<PathBuf>>> = Arc::new(Mutex::new(Vec::new()));
    preview::spawn_render_thread(rx, current.clone(), ffmpeg.clone(), preview_invalidate.clone());

    let state = AppState {
        ffmpeg,
        features: Mutex::new(HashMap::new()),
        current,
        preview_tx: tx,
        export_cancel: Mutex::new(None),
        fonts: Mutex::new(None),
        audio_mix: Mutex::new(None),
        preview_invalidate,
        edit_mtimes: Mutex::new(HashMap::new()),
    };

    // `mut` is only taken by the optional MCP / e2e plugin registrations below.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // Opt-in via the `mcp` cargo feature (`npm run dev:mcp`). Without it the
    // crate is not in the dependency graph at all, so nothing to strip later.
    #[cfg(feature = "mcp")]
    {
        builder = builder
            .plugin(tauri_plugin_mcp::init_with_config(
                tauri_plugin_mcp::PluginConfig::new("Qué lindo".to_string())
                    .start_socket_server(true)
                    .socket_path("/tmp/que-lindo-mcp.sock".into()),
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

    // WebdriverIO e2e bridge (`e2e` cargo feature, `npm run e2e:build`).
    // `wdio` answers execute/mock/log calls; `wdio-webdriver` is the embedded
    // WebDriver server the test runner connects to on TAURI_WEBDRIVER_PORT.
    #[cfg(feature = "e2e")]
    {
        builder = builder
            .plugin(tauri_plugin_wdio::init())
            .plugin(tauri_plugin_wdio_webdriver::init())
            .setup(|app| {
                use tauri::Manager;
                app.add_capability(include_str!("../wdio-capability.json"))?;
                Ok(())
            });
    }

    builder
        .manage(state)
        .manage(restore::RestoreState::default())
        .invoke_handler(tauri::generate_handler![
            restore::restore_status,
            restore::restore_start,
            restore::restore_alive,
            restore::restore_stop,
            embed_media,
            embed_available,
            group_moments,
            dump_grouping_features,
            face_embeddings,
            check_ffmpeg,
            startup_project,
            set_project,
            load_project,
            save_project,
            save_current_project,
            write_autosave,
            clear_autosave,
            autosave_info,
            probe_media,
            media_thumb,
            detect_focus,
            list_fonts,
            render_preview,
            render_audio_mix,
            export_video,
            cancel_export,
            reveal_path,
            edit_apps,
            open_in_app,
            changed_media,
            missing_paths,
            search_media_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The restore engine is a child process with its own children
            // (the PMRF worker); leaving it behind would pin gigabytes.
            if let tauri::RunEvent::Exit = event {
                app.state::<restore::RestoreState>().shutdown();
            }
        });
}
