//! Media I/O: ffmpeg/ffprobe discovery, probing, image decoding (with EXIF
//! orientation), and sequential video-frame decoding over an ffmpeg pipe.

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::Arc;
use vello_cpu::Pixmap;

/// Longest edge kept when decoding source media.
const MAX_DECODE_DIM: u32 = 3840;

// ---------------------------------------------------------------------------
// ffmpeg discovery
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Ffmpeg {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Ffmpeg {
    /// Discovery order: `SLIDESHOW_FFMPEG_DIR` env → next to the executable →
    /// `binaries/` next to the executable (Tauri sidecar layout) → PATH.
    pub fn locate() -> Result<Self> {
        let exe_name = |base: &str| {
            if cfg!(windows) {
                format!("{base}.exe")
            } else {
                base.to_string()
            }
        };

        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Ok(dir) = std::env::var("SLIDESHOW_FFMPEG_DIR") {
            dirs.push(PathBuf::from(dir));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                dirs.push(dir.to_path_buf());
                dirs.push(dir.join("binaries"));
            }
        }
        for dir in &dirs {
            let ff = dir.join(exe_name("ffmpeg"));
            let fp = dir.join(exe_name("ffprobe"));
            if ff.is_file() && fp.is_file() {
                return Ok(Self { ffmpeg: ff, ffprobe: fp });
            }
        }

        // PATH fallback: verify it actually runs.
        let ok = Command::new("ffmpeg")
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Ok(Self { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() });
        }
        bail!(
            "ffmpeg not found. Install ffmpeg (and ffprobe) on your PATH, place them next to the app, \
             or set SLIDESHOW_FFMPEG_DIR to the folder containing them."
        )
    }

    /// Whether this ffmpeg build offers the named encoder.
    pub fn has_encoder(&self, name: &str) -> bool {
        Command::new(&self.ffmpeg)
            .args(["-hide_banner", "-v", "error", "-encoders"])
            .stdin(Stdio::null())
            .output()
            .map(|out| {
                out.status.success()
                    && String::from_utf8_lossy(&out.stdout)
                        .lines()
                        // Listing rows look like " V....D h264_videotoolbox  desc".
                        .any(|l| l.split_whitespace().nth(1) == Some(name))
            })
            .unwrap_or(false)
    }

    pub fn probe(&self, path: &Path) -> Result<MediaInfo> {
        let out = Command::new(&self.ffprobe)
            .args(["-v", "error", "-print_format", "json", "-show_streams", "-show_format"])
            .arg(path)
            .stdin(Stdio::null())
            .output()
            .with_context(|| format!("running ffprobe on {}", path.display()))?;
        if !out.status.success() {
            bail!(
                "ffprobe failed on {}: {}",
                path.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout)?;
        let streams = v["streams"].as_array().cloned().unwrap_or_default();
        let mut info = MediaInfo::default();
        info.duration = v["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        for s in &streams {
            match s["codec_type"].as_str() {
                Some("video") => {
                    // Attached cover art shows up as a video stream; skip it.
                    if s["disposition"]["attached_pic"].as_i64() == Some(1) {
                        continue;
                    }
                    info.width = s["width"].as_u64().unwrap_or(0) as u32;
                    info.height = s["height"].as_u64().unwrap_or(0) as u32;
                    info.fps = parse_rate(s["avg_frame_rate"].as_str().unwrap_or(""))
                        .or_else(|| parse_rate(s["r_frame_rate"].as_str().unwrap_or("")))
                        .unwrap_or(0.0);
                    // A "video" stream with no timing is a still image.
                    info.has_video = info.fps > 0.0 && info.duration > 0.0;
                    if !info.has_video {
                        info.is_image = true;
                    }
                    // Rotation lives in side_data or tags depending on mux.
                    if let Some(sd) = s["side_data_list"].as_array() {
                        for d in sd {
                            if let Some(r) = d["rotation"].as_i64() {
                                info.rotation = r as i32;
                            }
                        }
                    }
                    if let Some(r) = s["tags"]["rotate"].as_str().and_then(|r| r.parse::<i32>().ok()) {
                        info.rotation = r;
                    }
                }
                Some("audio") => info.has_audio = true,
                _ => {}
            }
        }
        Ok(info)
    }
}

fn parse_rate(s: &str) -> Option<f64> {
    let (n, d) = s.split_once('/')?;
    let n: f64 = n.parse().ok()?;
    let d: f64 = d.parse().ok()?;
    if d == 0.0 || n == 0.0 {
        None
    } else {
        Some(n / d)
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct MediaInfo {
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub fps: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub is_image: bool,
    pub rotation: i32,
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/// Decode an image, apply EXIF orientation, downscale to MAX_DECODE_DIM,
/// convert to premultiplied pixels.
pub fn load_image(path: &Path) -> Result<Pixmap> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let img = image::load_from_memory(&bytes)
        .with_context(|| format!("decoding image {}", path.display()))?;
    let orientation = exif_orientation(&bytes).unwrap_or(1);
    let img = apply_orientation(img, orientation);
    let img = if img.width().max(img.height()) > MAX_DECODE_DIM {
        img.resize(MAX_DECODE_DIM, MAX_DECODE_DIM, image::imageops::FilterType::CatmullRom)
    } else {
        img
    };
    let rgba = img.into_rgba8();
    rgba_to_pixmap(rgba.width(), rgba.height(), rgba.as_raw())
}

fn exif_orientation(bytes: &[u8]) -> Option<u32> {
    let reader = exif::Reader::new();
    let e = reader.read_from_container(&mut std::io::Cursor::new(bytes)).ok()?;
    e.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?
        .value
        .get_uint(0)
}

fn apply_orientation(img: image::DynamicImage, o: u32) -> image::DynamicImage {
    match o {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// Straight-alpha RGBA bytes → premultiplied vello Pixmap.
pub fn rgba_to_pixmap(w: u32, h: u32, rgba: &[u8]) -> Result<Pixmap> {
    if w == 0 || h == 0 || w > u16::MAX as u32 || h > u16::MAX as u32 {
        anyhow::bail!("bad image dimensions {w}x{h}");
    }
    let mut pm = Pixmap::new(w as u16, h as u16);
    let data = pm.data_as_u8_slice_mut();
    debug_assert_eq!(data.len(), rgba.len());
    let mut opaque = true;
    for (dst, src) in data.chunks_exact_mut(4).zip(rgba.chunks_exact(4)) {
        let a = src[3] as u32;
        if a == 255 {
            dst.copy_from_slice(src);
        } else {
            opaque = false;
            dst[0] = (src[0] as u32 * a / 255) as u8;
            dst[1] = (src[1] as u32 * a / 255) as u8;
            dst[2] = (src[2] as u32 * a / 255) as u8;
            dst[3] = src[3];
        }
    }
    // Opaque sources take vello's fast blit path.
    pm.set_may_have_transparency(!opaque);
    Ok(pm)
}

// ---------------------------------------------------------------------------
// Video (sequential rawvideo pipe)
// ---------------------------------------------------------------------------

/// Reads frames from one clip through ffmpeg at a fixed sampling fps.
/// Optimized for monotonically increasing requests (export order); seeks
/// restart the pipe.
struct VideoReader {
    path: PathBuf,
    ffmpeg: Ffmpeg,
    info: MediaInfo,
    out_w: u32,
    out_h: u32,
    fps: f64,
    child: Option<Child>,
    stdout: Option<ChildStdout>,
    /// Index (at `fps`) of the *next* frame the pipe will yield.
    next_index: i64,
    /// Timestamp of the first frame the current pipe yields.
    pipe_base: f64,
    last_frame: Option<Arc<Pixmap>>,
    last_index: i64,
    eof: bool,
}

impl VideoReader {
    fn new(ffmpeg: Ffmpeg, path: &Path, fps: f64) -> Result<Self> {
        let info = ffmpeg.probe(path)?;
        if !info.has_video {
            bail!("{} has no video stream", path.display());
        }
        // Rotation metadata swaps display dimensions (ffmpeg auto-rotates output).
        let (mut w, mut h) = (info.width.max(2), info.height.max(2));
        if info.rotation.abs() % 180 == 90 {
            std::mem::swap(&mut w, &mut h);
        }
        // Cap decode size; keep even for safety.
        let scale = (1920.0 / w.max(h) as f64).min(1.0);
        let out_w = (((w as f64 * scale) as u32) & !1).max(2);
        let out_h = (((h as f64 * scale) as u32) & !1).max(2);
        Ok(Self {
            path: path.to_path_buf(),
            ffmpeg,
            info,
            out_w,
            out_h,
            fps,
            child: None,
            stdout: None,
            next_index: 0,
            pipe_base: 0.0,
            last_frame: None,
            last_index: -1,
            eof: false,
        })
    }

    fn frame_size(&self) -> usize {
        (self.out_w * self.out_h * 4) as usize
    }

    fn start_pipe(&mut self, from: f64) -> Result<()> {
        self.stop();
        let from = from.max(0.0);
        let mut cmd = Command::new(&self.ffmpeg.ffmpeg);
        cmd.args(["-v", "error", "-nostdin"]);
        if from > 0.0 {
            cmd.args(["-ss", &format!("{from:.4}")]);
        }
        cmd.arg("-i")
            .arg(&self.path)
            .args([
                "-vf",
                &format!("fps={:.6},scale={}:{}", self.fps, self.out_w, self.out_h),
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "-an",
                "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawning ffmpeg decoder for {}", self.path.display()))?;
        self.stdout = child.stdout.take();
        self.child = Some(child);
        self.pipe_base = from;
        self.next_index = (from * self.fps).round() as i64;
        self.eof = false;
        Ok(())
    }

    fn stop(&mut self) {
        self.stdout = None;
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// Frame at absolute clip time `t` seconds.
    fn frame_at(&mut self, t: f64) -> Result<Arc<Pixmap>> {
        let t = t.clamp(0.0, (self.info.duration - 0.001).max(0.0));
        let want = (t * self.fps).floor() as i64;

        if self.last_index == want {
            if let Some(f) = &self.last_frame {
                return Ok(f.clone());
            }
        }

        // Restart the pipe on a backward seek or a large forward jump.
        let needs_restart = self.stdout.is_none()
            || want < self.next_index
            || want > self.next_index + (self.fps * 3.0) as i64;
        if needs_restart {
            self.start_pipe(want as f64 / self.fps)?;
        }

        let size = self.frame_size();
        let mut buf = vec![0u8; size];
        while self.next_index <= want {
            let stdout = self.stdout.as_mut().context("decoder pipe missing")?;
            match read_exact_or_eof(stdout, &mut buf)? {
                true => {
                    self.next_index += 1;
                }
                false => {
                    // Clip ended early (duration metadata optimistic): hold last frame.
                    self.eof = true;
                    break;
                }
            }
        }

        if !self.eof || self.last_frame.is_none() {
            let pm = rgba_to_pixmap(self.out_w, self.out_h, &buf)?;
            self.last_frame = Some(Arc::new(pm));
        }
        self.last_index = want;
        Ok(self.last_frame.clone().expect("frame set above"))
    }
}

impl Drop for VideoReader {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Ok(true) = filled, Ok(false) = clean EOF at a frame boundary (or mid-frame).
fn read_exact_or_eof(r: &mut impl Read, buf: &mut [u8]) -> Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = r.read(&mut buf[filled..])?;
        if n == 0 {
            return Ok(false);
        }
        filled += n;
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/// Shared media cache used by both preview and export.
pub struct MediaCache {
    ffmpeg: Option<Ffmpeg>,
    images: HashMap<PathBuf, Arc<Pixmap>>,
    videos: HashMap<PathBuf, VideoReader>,
    probes: HashMap<PathBuf, MediaInfo>,
}

impl MediaCache {
    pub fn new(ffmpeg: Option<Ffmpeg>) -> Self {
        Self {
            ffmpeg,
            images: HashMap::new(),
            videos: HashMap::new(),
            probes: HashMap::new(),
        }
    }

    pub fn ffmpeg(&self) -> Option<&Ffmpeg> {
        self.ffmpeg.as_ref()
    }

    pub fn image(&mut self, path: &Path) -> Result<Arc<Pixmap>> {
        if let Some(pm) = self.images.get(path) {
            return Ok(pm.clone());
        }
        let pm = Arc::new(load_image(path)?);
        self.images.insert(path.to_path_buf(), pm.clone());
        Ok(pm)
    }

    /// Video frame at clip time `t`, sampled at `fps`.
    pub fn video_frame(&mut self, path: &Path, t: f64, fps: f64) -> Result<Arc<Pixmap>> {
        if !self.videos.contains_key(path) {
            let ffmpeg = self
                .ffmpeg
                .clone()
                .context("video clips require ffmpeg, which was not found")?;
            let reader = VideoReader::new(ffmpeg, path, fps)?;
            self.videos.insert(path.to_path_buf(), reader);
        }
        self.videos.get_mut(path).unwrap().frame_at(t)
    }

    pub fn probe(&mut self, path: &Path) -> Result<MediaInfo> {
        if let Some(i) = self.probes.get(path) {
            return Ok(i.clone());
        }
        let ffmpeg = self.ffmpeg.clone().context("ffmpeg not found")?;
        let info = ffmpeg.probe(path)?;
        self.probes.insert(path.to_path_buf(), info.clone());
        Ok(info)
    }

    /// Drop decoder pipes (e.g. after an export completes).
    pub fn reset_decoders(&mut self) {
        self.videos.clear();
    }
}
