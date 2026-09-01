//! Focal-point detection for zoom defaults: find the faces, aim there.
//! rustface (SeetaFace) — pure Rust, bundled model, fully offline.

use image::imageops::FilterType;
use rustface::{Detector, ImageData};
use std::cell::RefCell;
use std::io::Cursor;
use std::path::Path;

static MODEL_BYTES: &[u8] = include_bytes!("../assets/seeta_fd_frontal_v1.0.bin");

thread_local! {
    /// One detector per blocking-pool thread (the box isn't Send); model
    /// parse happens once per thread, detections run in parallel.
    static DETECTOR: RefCell<Option<Box<dyn Detector>>> = const { RefCell::new(None) };
}

fn build_detector() -> Option<Box<dyn Detector>> {
    let model = rustface::model::read_model(Cursor::new(MODEL_BYTES)).ok()?;
    let mut detector = rustface::create_detector_with_model(model);
    detector.set_min_face_size(20);
    detector.set_score_thresh(2.0);
    detector.set_pyramid_scale_factor(0.8);
    detector.set_slide_window_step(4, 4);
    Some(detector)
}

/// The photo's focal point as fractions of its frame, or None when no face
/// is found (callers fall back to center). Multiple faces resolve to their
/// size-weighted centroid — a group photo zooms toward the group.
pub fn detect_focus(path: &Path) -> Option<[f32; 2]> {
    let img = image::open(path).ok()?;
    let (w0, h0) = (img.width().max(1), img.height().max(1));
    let scale = (480.0 / w0.max(h0) as f32).min(1.0);
    let w = ((w0 as f32 * scale) as u32).max(1);
    let h = ((h0 as f32 * scale) as u32).max(1);
    let gray = img.resize_exact(w, h, FilterType::Triangle).to_luma8();
    let data = ImageData::new(gray.as_raw(), gray.width(), gray.height());

    let faces = DETECTOR.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = build_detector();
        }
        slot.as_mut().map(|d| d.detect(&data))
    })?;
    if faces.is_empty() {
        return None;
    }

    let mut sum_w = 0.0f32;
    let mut fx = 0.0f32;
    let mut fy = 0.0f32;
    for face in &faces {
        let b = face.bbox();
        let weight = (b.width() * b.height()) as f32;
        let cx = b.x() as f32 + b.width() as f32 / 2.0;
        let cy = b.y() as f32 + b.height() as f32 / 2.0;
        fx += cx * weight;
        fy += cy * weight;
        sum_w += weight;
    }
    if sum_w <= 0.0 {
        return None;
    }
    Some([
        (fx / sum_w / gray.width() as f32).clamp(0.0, 1.0),
        (fy / sum_w / gray.height() as f32).clamp(0.0, 1.0),
    ])
}
