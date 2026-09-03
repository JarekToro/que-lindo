use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use slideshow_core::export::{export, CancelFlag, ExportOptions, VideoEncoder};
use slideshow_core::{Ffmpeg, Project, Renderer, Timeline};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Focused slideshow-video maker: images + video clips + music → MP4.
#[derive(Parser)]
#[command(name = "slideshow", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Scaffold an example project file in a directory.
    New {
        dir: PathBuf,
    },
    /// Show media metadata as JSON (via ffprobe).
    Probe {
        path: PathBuf,
    },
    /// Render a single frame to a PNG (great for checking a project).
    Frame {
        project: PathBuf,
        /// Time in seconds.
        #[arg(short, long, default_value_t = 0.0)]
        time: f64,
        #[arg(short, long, default_value = "frame.png")]
        out: PathBuf,
        /// Render scale (1.0 = full resolution).
        #[arg(long, default_value_t = 1.0)]
        scale: f32,
    },
    /// Render the whole project to an MP4.
    Render {
        project: PathBuf,
        #[arg(short, long, default_value = "slideshow.mp4")]
        out: PathBuf,
        /// Render scale (1.0 = full resolution).
        #[arg(long, default_value_t = 1.0)]
        scale: f32,
        /// x264 CRF quality (lower = better, 18–28 sensible).
        #[arg(long, default_value_t = 19)]
        crf: u8,
        /// x264 preset (ultrafast..veryslow).
        #[arg(long, default_value = "medium")]
        preset: String,
        /// H.264 encoder: auto = hardware (VideoToolbox) when available.
        #[arg(long, value_enum, default_value_t = EncoderArg::Auto)]
        encoder: EncoderArg,
    },
    /// Print the total duration and per-slide timing of a project.
    Info {
        project: PathBuf,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Cmd::New { dir } => cmd_new(&dir),
        Cmd::Probe { path } => cmd_probe(&path),
        Cmd::Frame { project, time, out, scale } => cmd_frame(&project, time, &out, scale),
        Cmd::Render { project, out, scale, crf, preset, encoder } => {
            cmd_render(&project, &out, scale, crf, preset, encoder.into())
        }
        Cmd::Info { project } => cmd_info(&project),
    }
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum EncoderArg {
    Auto,
    X264,
    Videotoolbox,
}

impl From<EncoderArg> for VideoEncoder {
    fn from(e: EncoderArg) -> Self {
        match e {
            EncoderArg::Auto => VideoEncoder::Auto,
            EncoderArg::X264 => VideoEncoder::X264,
            EncoderArg::Videotoolbox => VideoEncoder::VideoToolbox,
        }
    }
}

fn load_project(path: &Path) -> Result<Project> {
    let json = std::fs::read_to_string(path)
        .with_context(|| format!("reading project {}", path.display()))?;
    let mut project = Project::from_json(&json)?;
    if let Some(dir) = path.parent() {
        project.resolve_paths(dir);
    }
    Ok(project)
}

fn check_media(project: &Project) -> Result<()> {
    let missing: Vec<String> = project
        .referenced_paths()
        .into_iter()
        .filter(|p| !p.is_file())
        .map(|p| p.display().to_string())
        .collect();
    if !missing.is_empty() {
        bail!("missing media files:\n  {}", missing.join("\n  "));
    }
    Ok(())
}

fn renderer() -> Renderer {
    let ffmpeg = match Ffmpeg::locate() {
        Ok(f) => Some(f),
        Err(e) => {
            eprintln!("warning: {e}");
            None
        }
    };
    Renderer::new(ffmpeg)
}

fn cmd_new(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("project.slideshow.json");
    if path.exists() {
        bail!("{} already exists", path.display());
    }
    let project = example_project();
    std::fs::write(&path, project.to_json())?;
    println!("created {}", path.display());
    println!("render it with: slideshow render {} -o out.mp4", path.display());
    Ok(())
}

fn cmd_probe(path: &Path) -> Result<()> {
    let ffmpeg = Ffmpeg::locate()?;
    let info = ffmpeg.probe(path)?;
    println!("{}", serde_json::to_string_pretty(&info)?);
    Ok(())
}

fn cmd_info(path: &Path) -> Result<()> {
    let project = load_project(path)?;
    let timeline = Timeline::new(&project);
    println!(
        "{}x{} @ {} fps, {} slides, total {:.2}s",
        project.settings.width,
        project.settings.height,
        project.settings.fps,
        project.slides.len(),
        timeline.total_duration()
    );
    for (i, slide) in project.slides.iter().enumerate() {
        println!(
            "  #{i:<3} {:>7.2}s → {:>7.2}s  {:>5.2}s  cells={} texts={} id={}",
            timeline.slide_start(i),
            timeline.slide_end(i),
            slide.duration,
            slide.cells.len(),
            slide.texts.len(),
            slide.id
        );
    }
    Ok(())
}

fn cmd_frame(path: &Path, time: f64, out: &Path, scale: f32) -> Result<()> {
    let project = load_project(path)?;
    let timeline = Timeline::new(&project);
    let mut renderer = renderer();
    let frame = renderer.render_frame(&project, &timeline, time, scale)?;
    let (w, h) = (frame.width(), frame.height());
    let png = frame.into_png().context("encoding PNG")?;
    std::fs::write(out, png).with_context(|| format!("writing {}", out.display()))?;
    println!("wrote {} ({w}x{h})", out.display());
    Ok(())
}

fn cmd_render(
    path: &Path,
    out: &Path,
    scale: f32,
    crf: u8,
    preset: String,
    encoder: VideoEncoder,
) -> Result<()> {
    let project = load_project(path)?;
    check_media(&project)?;
    let mut renderer = renderer();
    let options = ExportOptions { scale, crf, preset, encoder };
    let cancel: CancelFlag = Arc::new(AtomicBool::new(false));
    {
        let cancel = cancel.clone();
        ctrlc_handler(move || cancel.store(true, std::sync::atomic::Ordering::Relaxed));
    }
    let started = std::time::Instant::now();
    let done = export(&project, &mut renderer, out, &options, cancel, |done, total| {
        let pct = done * 100 / total;
        eprint!("\rrendering {done}/{total} frames ({pct}%) ");
        let _ = std::io::stderr().flush();
    })?;
    eprintln!();
    if !done {
        bail!("export cancelled");
    }
    println!("wrote {} in {:.1}s", out.display(), started.elapsed().as_secs_f32());
    Ok(())
}

/// Minimal Ctrl-C hook without an extra dependency.
fn ctrlc_handler(f: impl Fn() + Send + Sync + 'static) {
    // Best-effort: if the hook can't be set, Ctrl-C just kills the process.
    #[cfg(unix)]
    unsafe {
        static mut HANDLER: Option<Box<dyn Fn() + Send + Sync>> = None;
        unsafe extern "C" fn trampoline(_: i32) {
            #[allow(static_mut_refs)]
            if let Some(h) = HANDLER.as_ref() {
                h();
            }
        }
        #[allow(static_mut_refs)]
        {
            HANDLER = Some(Box::new(f));
        }
        libc_signal(2, trampoline as *const () as usize); // SIGINT
    }
    #[cfg(not(unix))]
    let _ = f;
}

#[cfg(unix)]
unsafe fn libc_signal(sig: i32, handler: usize) {
    unsafe extern "C" {
        fn signal(sig: i32, handler: usize) -> usize;
    }
    unsafe {
        signal(sig, handler);
    }
}

fn example_project() -> Project {
    use slideshow_core::model::*;
    let mut p = Project::default();
    p.slides.push(Slide {
        id: "title".into(),
        duration: 4.0,
        texts: vec![
            TextOverlay {
                text: "In Loving Memory".into(),
                role: TextRole::Title,
                size: 0.11,
                anchor: Anchor::Center,
                offset: [0.0, -0.05],
                ..Default::default()
            },
            TextOverlay {
                text: "1943 – 2026".into(),
                role: TextRole::Subtitle,
                size: 0.05,
                anchor: Anchor::Center,
                offset: [0.0, 0.07],
                ..Default::default()
            },
        ],
        ..Default::default()
    });
    p.slides.push(Slide {
        id: "photos".into(),
        duration: 5.0,
        layout: Layout::Featured { side: Side::Left, ratio: 0.62 },
        margin: 0.03,
        gutter: 0.02,
        cells: vec![
            Cell { corner_radius: 0.01, ..Cell::image("photo1.jpg") },
            Cell { corner_radius: 0.01, ..Cell::image("photo2.jpg") },
            Cell { corner_radius: 0.01, ..Cell::image("photo3.jpg") },
        ],
        texts: vec![TextOverlay {
            text: "Family, 1974".into(),
            role: TextRole::Caption,
            size: 0.035,
            ..Default::default()
        }],
        transition: Transition { kind: TransitionKind::CrossFade, duration: 1.0 },
        ..Default::default()
    });
    p
}
