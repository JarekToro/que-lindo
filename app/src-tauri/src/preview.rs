//! Preview rendering thread — frames come from the same compositor as export.
//! Frames cross IPC as raw bytes (`tauri::ipc::Response`, never base64): an
//! 8-byte header (width u32 LE, height u32 LE) followed by straight-alpha
//! RGBA pixels. Skipping the PNG encode keeps the playback hot path cheap.
//!
//! The thread keeps an LRU cache keyed on (project revision, quantised time,
//! scale) and coalesces queued jobs so a scrub renders only the newest wanted
//! frame instead of every position the pointer passed through.

use slideshow_core::{Ffmpeg, Pixmap, Project, Renderer, Timeline};
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};

/// Frame times snap to this grid for rendering and cache lookup. Finer than
/// the 12 fps playback tick, so quantisation is invisible; coarse enough that
/// replaying or re-scrubbing the same second hits the cache.
const QUANT_HZ: f64 = 48.0;

/// Upper bound on retained frame bytes (~64 half-scale 1080p frames).
const CACHE_BUDGET_BYTES: usize = 128 * 1024 * 1024;

pub struct CurrentDoc {
    pub project: Arc<Project>,
    pub timeline: Arc<Timeline>,
    pub rev: u64,
}

pub struct Job {
    pub time: f64,
    pub scale: f32,
    pub reply: Sender<Result<Arc<Vec<u8>>, String>>,
}

/// Sent to a queued job that lost the race to a newer request; the frontend
/// treats it as "skip", not as a failure.
pub const SUPERSEDED: &str = "superseded";

#[derive(PartialEq, Eq, Hash, Clone, Copy)]
struct Key {
    rev: u64,
    qtime: u64,
    scale_milli: u32,
}

impl Key {
    fn new(rev: u64, job: &Job) -> Self {
        Key {
            rev,
            qtime: (job.time.max(0.0) * QUANT_HZ).round() as u64,
            scale_milli: (job.scale * 1000.0).round() as u32,
        }
    }

    fn render_time(&self) -> f64 {
        self.qtime as f64 / QUANT_HZ
    }
}

struct FrameCache {
    map: HashMap<Key, (Arc<Vec<u8>>, u64)>,
    bytes: usize,
    tick: u64,
    rev: u64,
}

impl FrameCache {
    fn new() -> Self {
        FrameCache { map: HashMap::new(), bytes: 0, tick: 0, rev: 0 }
    }

    /// Frames from older revisions can never be requested again.
    fn set_rev(&mut self, rev: u64) {
        if rev == self.rev {
            return;
        }
        self.rev = rev;
        self.map.retain(|k, _| k.rev == rev);
        self.bytes = self.map.values().map(|(v, _)| v.len()).sum();
    }

    fn get(&mut self, key: &Key) -> Option<Arc<Vec<u8>>> {
        self.tick += 1;
        let tick = self.tick;
        self.map.get_mut(key).map(|(v, stamp)| {
            *stamp = tick;
            v.clone()
        })
    }

    fn put(&mut self, key: Key, value: Arc<Vec<u8>>) {
        self.tick += 1;
        self.bytes += value.len();
        if let Some((old, _)) = self.map.insert(key, (value, self.tick)) {
            self.bytes -= old.len();
        }
        while self.bytes > CACHE_BUDGET_BYTES && self.map.len() > 1 {
            let oldest = self
                .map
                .iter()
                .min_by_key(|(_, (_, stamp))| *stamp)
                .map(|(k, _)| *k)
                .expect("non-empty");
            if let Some((v, _)) = self.map.remove(&oldest) {
                self.bytes -= v.len();
            }
        }
    }
}

/// Header + straight-alpha RGBA. tiny-skia stores premultiplied pixels;
/// preview frames are opaque so this is near a memcpy, but demultiplying
/// keeps partially transparent output correct too.
fn frame_to_bytes(pm: &Pixmap) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + pm.pixels().len() * 4);
    out.extend_from_slice(&pm.width().to_le_bytes());
    out.extend_from_slice(&pm.height().to_le_bytes());
    for px in pm.pixels() {
        let c = px.demultiply();
        out.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
    }
    out
}

pub fn spawn_render_thread(
    rx: Receiver<Job>,
    current: Arc<Mutex<Option<CurrentDoc>>>,
    ffmpeg: Option<Ffmpeg>,
) {
    std::thread::spawn(move || {
        let mut renderer = Renderer::new(ffmpeg);
        let mut cache = FrameCache::new();
        while let Ok(first) = rx.recv() {
            // Coalesce: drain everything queued, keep only the newest job to
            // render. Older jobs are answered from cache or told "superseded".
            let mut jobs = vec![first];
            while let Ok(j) = rx.try_recv() {
                jobs.push(j);
            }

            let doc = current
                .lock()
                .unwrap()
                .as_ref()
                .map(|d| (d.project.clone(), d.timeline.clone(), d.rev));
            let Some((project, timeline, rev)) = doc else {
                for job in jobs {
                    let _ = job.reply.send(Err("no project loaded".to_string()));
                }
                continue;
            };
            cache.set_rev(rev);

            let newest = jobs.pop().expect("at least one job");
            for job in jobs {
                let key = Key::new(rev, &job);
                let reply = match cache.get(&key) {
                    Some(bytes) => Ok(bytes),
                    None => Err(SUPERSEDED.to_string()),
                };
                let _ = job.reply.send(reply);
            }

            let key = Key::new(rev, &newest);
            let result = match cache.get(&key) {
                Some(bytes) => Ok(bytes),
                None => renderer
                    .render_frame(&project, &timeline, key.render_time(), newest.scale)
                    .map_err(|e| format!("render: {e:#}"))
                    .map(|frame| {
                        let bytes = Arc::new(frame_to_bytes(&frame));
                        cache.put(key, bytes.clone());
                        bytes
                    }),
            };
            if let Err(e) = &result {
                log::warn!("preview render failed: {e}");
            }
            let _ = newest.reply.send(result);
        }
    });
}
