//! Full export: composed frames piped into ffmpeg, mixed audio, H.264/AAC MP4.

use crate::audio;
use crate::compositor::Renderer;
use crate::model::Project;
use crate::timeline::Timeline;
use anyhow::{bail, Context, Result};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct ExportOptions {
    /// 0..1 render scale (1.0 = full project resolution).
    pub scale: f32,
    /// x264 CRF, lower = better/larger. 18 is visually lossless-ish.
    /// Hardware encoders map this onto their own quality scale.
    pub crf: u8,
    /// x264 speed preset (software encoding only).
    pub preset: String,
    /// Which H.264 encoder to use.
    pub encoder: VideoEncoder,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self { scale: 1.0, crf: 19, preset: "medium".into(), encoder: VideoEncoder::Auto }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VideoEncoder {
    /// Hardware (VideoToolbox) when the ffmpeg build offers it, else x264.
    #[default]
    Auto,
    /// Software libx264: best quality per bit, heavy on CPU.
    X264,
    /// Apple VideoToolbox hardware encoder: much faster and near-zero CPU,
    /// slightly larger files at equal quality.
    VideoToolbox,
}

/// Cooperative cancel flag; set true to abort an export in flight.
pub type CancelFlag = Arc<AtomicBool>;

/// Render the whole project into `out`. Calls `progress(done, total)` per
/// frame. Returns Err on encode failure, Ok(false) if cancelled, Ok(true) on
/// success.
pub fn export(
    project: &Project,
    renderer: &mut Renderer,
    out: &Path,
    options: &ExportOptions,
    cancel: CancelFlag,
    mut progress: impl FnMut(u64, u64),
) -> Result<bool> {
    if project.slides.is_empty() {
        bail!("project has no slides");
    }
    let ffmpeg = renderer
        .cache
        .ffmpeg()
        .context("ffmpeg is required for export but was not found")?
        .clone();

    let timeline = Timeline::new(project);
    let fps = project.settings.fps.clamp(1.0, 120.0);
    let total_frames = (timeline.total_duration() * fps).round().max(1.0) as u64;

    // Probe one frame for the actual output dimensions at this scale.
    let first = renderer.render_frame(project, &timeline, 0.0, options.scale)?;
    let (w, h) = (first.width() as u32, first.height() as u32);

    let audio_plan = audio::plan(project, &timeline, &mut renderer.cache);

    let mut cmd = Command::new(&ffmpeg.ffmpeg);
    cmd.args(["-v", "error", "-y", "-nostdin"]);
    // Input 0: raw frames on stdin.
    cmd.args([
        "-f", "rawvideo",
        "-pix_fmt", "rgba",
        "-s", &format!("{w}x{h}"),
        "-r", &format!("{fps}"),
        "-i", "-",
    ]);
    for input in &audio_plan.inputs {
        if input.loop_input {
            cmd.args(["-stream_loop", "-1"]);
        }
        cmd.arg("-i").arg(&input.path);
    }
    if audio_plan.filter.is_empty() {
        cmd.args(["-map", "0:v", "-an"]);
    } else {
        cmd.args(["-filter_complex", &audio_plan.filter]);
        cmd.args(["-map", "0:v", "-map", "[aout]"]);
        cmd.args(["-c:a", "aac", "-b:a", "192k"]);
    }
    let use_videotoolbox = match options.encoder {
        VideoEncoder::X264 => false,
        VideoEncoder::VideoToolbox => true,
        VideoEncoder::Auto => ffmpeg.has_encoder("h264_videotoolbox"),
    };
    if use_videotoolbox {
        cmd.args(["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p"]);
        if ffmpeg.videotoolbox_takes_qscale() {
            // VideoToolbox has no CRF; its constant-quality scale runs 1..100,
            // higher = better. Map the familiar CRF knob onto it (19 → 62).
            let q = (100i32 - 2 * options.crf as i32).clamp(1, 100);
            cmd.args(["-q:v", &q.to_string()]);
        } else {
            // No constant-quality mode in this build. Aim a bitrate at roughly
            // the same picture instead: H.264 lands near 0.12 bits per pixel at
            // CRF 18 and loses about 12% per CRF step from there.
            let bpp = 0.12_f64 * 0.88_f64.powi(options.crf as i32 - 18);
            let bps = (w as f64 * h as f64 * fps * bpp).clamp(200_000.0, 60_000_000.0);
            cmd.args(["-b:v", &format!("{}", bps.round() as u64)]);
        }
    } else {
        cmd.args([
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-crf", &options.crf.to_string(),
            "-preset", &options.preset,
        ]);
    }
    cmd.args([
        "-movflags", "+faststart",
        "-t", &format!("{:.4}", timeline.total_duration()),
    ]);
    cmd.arg(out);
    cmd.stdin(Stdio::piped()).stderr(Stdio::piped()).stdout(Stdio::null());

    let mut child = cmd.spawn().context("spawning ffmpeg encoder")?;
    let mut stdin = child.stdin.take().context("encoder stdin")?;

    let mut cancelled = false;
    let mut write_err: Option<std::io::Error> = None;
    for i in 0..total_frames {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let t = i as f64 / fps;
        let frame = if i == 0 {
            first.clone()
        } else {
            renderer.render_frame(project, &timeline, t, options.scale)?
        };
        // Frames are fully opaque, so premultiplied data == straight RGBA.
        if let Err(e) = stdin.write_all(frame.data_as_u8_slice()) {
            write_err = Some(e);
            break;
        }
        progress(i + 1, total_frames);
    }
    drop(stdin);

    renderer.cache.reset_decoders();

    if cancelled {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(false);
    }

    let output = child.wait_with_output().context("waiting for ffmpeg encoder")?;
    if !output.status.success() {
        bail!(
            "ffmpeg encoding failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    if let Some(e) = write_err {
        // ffmpeg exited early but claimed success — surface the pipe error.
        bail!("frame pipe closed early: {e}");
    }
    Ok(true)
}
