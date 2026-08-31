//! Preview rendering thread — frames come from the same compositor as export.
//! The frontend calls the `render_preview` command; frames return as
//! data:image/png;base64 URLs (no custom scheme, identical on all platforms).

use base64::Engine;
use slideshow_core::{Ffmpeg, Project, Renderer, Timeline};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};

pub struct CurrentDoc {
    pub project: Arc<Project>,
    pub timeline: Arc<Timeline>,
}

pub struct Job {
    pub time: f64,
    pub scale: f32,
    pub reply: Sender<Result<String, String>>,
}

pub fn spawn_render_thread(
    rx: Receiver<Job>,
    current: Arc<Mutex<Option<CurrentDoc>>>,
    ffmpeg: Option<Ffmpeg>,
) {
    std::thread::spawn(move || {
        let mut renderer = Renderer::new(ffmpeg);
        while let Ok(job) = rx.recv() {
            let doc = current
                .lock()
                .unwrap()
                .as_ref()
                .map(|d| (d.project.clone(), d.timeline.clone()));
            let result = match doc {
                None => Err("no project loaded".to_string()),
                Some((project, timeline)) => renderer
                    .render_frame(&project, &timeline, job.time, job.scale)
                    .map_err(|e| format!("render: {e:#}"))
                    .and_then(|frame| frame.encode_png().map_err(|e| format!("png encode: {e}")))
                    .map(|png| {
                        format!(
                            "data:image/png;base64,{}",
                            base64::engine::general_purpose::STANDARD.encode(png)
                        )
                    }),
            };
            if let Err(e) = &result {
                log::warn!("preview render failed: {e}");
            }
            let _ = job.reply.send(result);
        }
    });
}
