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
use std::path::PathBuf;
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
    /// Draw text overlays at full opacity (the editing view).
    pub reveal_texts: bool,
    /// The frontend's revision when it asked. The request can beat the
    /// debounced `set_project`, so the render waits (briefly) for the doc
    /// to catch up rather than serving a stale frame as the new revision.
    pub min_rev: u64,
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
    reveal_texts: bool,
}

impl Key {
    fn new(rev: u64, job: &Job) -> Self {
        Key {
            rev,
            qtime: (job.time.max(0.0) * QUANT_HZ).round() as u64,
            scale_milli: (job.scale * 1000.0).round() as u32,
            reveal_texts: job.reveal_texts,
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

    /// Media changed on disk: every retained frame may show stale pixels.
    fn clear(&mut self) {
        self.map.clear();
        self.bytes = 0;
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

/// Header + straight-alpha RGBA. The pixmap stores premultiplied pixels;
/// preview frames are opaque so this is near a memcpy, but demultiplying
/// keeps partially transparent output correct too.
fn frame_to_bytes(pm: &Pixmap) -> Vec<u8> {
    let data = pm.data_as_u8_slice();
    let mut out = Vec::with_capacity(8 + data.len());
    out.extend_from_slice(&(pm.width() as u32).to_le_bytes());
    out.extend_from_slice(&(pm.height() as u32).to_le_bytes());
    for px in data.chunks_exact(4) {
        let a = px[3];
        if a == 255 || a == 0 {
            out.extend_from_slice(px);
        } else {
            let un = |c: u8| ((c as u32 * 255 + (a as u32 / 2)) / a as u32).min(255) as u8;
            out.extend_from_slice(&[un(px[0]), un(px[1]), un(px[2]), a]);
        }
    }
    out
}

pub fn spawn_render_thread(
    rx: Receiver<Job>,
    current: Arc<Mutex<Option<CurrentDoc>>>,
    ffmpeg: Option<Ffmpeg>,
    invalidate: Arc<Mutex<Vec<PathBuf>>>,
) {
    std::thread::spawn(move || {
        let mut renderer = Renderer::new(ffmpeg.clone());
        let mut cache = FrameCache::new();
        while let Ok(first) = rx.recv() {
            // Coalesce: drain everything queued, keep only the newest job to
            // render. Older jobs are answered from cache or told "superseded".
            let mut jobs = vec![first];
            while let Ok(j) = rx.try_recv() {
                jobs.push(j);
            }

            // Files edited externally since the last frame: drop their decoded
            // pixels and every retained frame (any of them may composite the
            // stale image).
            let dirty = std::mem::take(&mut *invalidate.lock().unwrap());
            if !dirty.is_empty() {
                for p in &dirty {
                    renderer.cache.forget(p);
                }
                cache.clear();
            }

            let newest_min_rev = jobs.last().map(|j| j.min_rev).unwrap_or(0);
            let fetch = || {
                current
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|d| (d.project.clone(), d.timeline.clone(), d.rev))
            };
            let mut doc = fetch();
            // Give the debounced project sync a moment to land the revision
            // this request was made against (bounded, then render what's here).
            let mut waits = 0;
            while doc.as_ref().map(|d| d.2 < newest_min_rev).unwrap_or(false) && waits < 12 {
                std::thread::sleep(std::time::Duration::from_millis(50));
                doc = fetch();
                waits += 1;
            }
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
                None => {
                    // A panic must cost this frame, not the preview for the
                    // rest of the session: catch it, rebuild the renderer
                    // (its caches may be mid-mutation), and keep serving.
                    let rendered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        renderer.render_frame_opts(
                            &project,
                            &timeline,
                            key.render_time(),
                            newest.scale,
                            newest.reveal_texts,
                        )
                    }));
                    match rendered {
                        Err(_) => {
                            renderer = Renderer::new(ffmpeg.clone());
                            Err("render panicked; renderer restarted".to_string())
                        }
                        Ok(r) => r.map_err(|e| format!("render: {e:#}")).map(|frame| {
                            let bytes = Arc::new(frame_to_bytes(&frame));
                            cache.put(key, bytes.clone());
                            bytes
                        }),
                    }
                }
            };
            if let Err(e) = &result {
                log::warn!("preview render failed: {e}");
            }
            let _ = newest.reply.send(result);
        }
    });
}
