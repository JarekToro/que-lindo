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

#[derive(Debug, serde::Serialize)]
pub struct FocusInfo {
    /// Size-weighted centroid of the faces, as frame fractions.
    pub point: [f32; 2],
    /// Padded union box of every face `[x, y, w, h]`, frame fractions —
    /// what Smart fit keeps in frame.
    pub region: [f32; 4],
}

/// The photo's faces, or None when nothing is found (callers fall back to
/// center). Multiple faces resolve to a centroid and a group box — a group
/// photo frames the group.
pub fn detect_focus(path: &Path) -> Option<FocusInfo> {
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
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, 0.0f32, 0.0f32);
    for face in &faces {
        let b = face.bbox();
        let (bx, by) = (b.x() as f32, b.y() as f32);
        let (bw, bh) = (b.width() as f32, b.height() as f32);
        let weight = bw * bh;
        fx += (bx + bw / 2.0) * weight;
        fy += (by + bh / 2.0) * weight;
        sum_w += weight;
        x0 = x0.min(bx);
        y0 = y0.min(by);
        x1 = x1.max(bx + bw);
        y1 = y1.max(by + bh);
    }
    if sum_w <= 0.0 {
        return None;
    }
    let (gw, gh) = (gray.width() as f32, gray.height() as f32);
    // Pad the union so foreheads and shoulders make the frame too.
    let pad_x = (x1 - x0) * 0.3;
    let pad_y = (y1 - y0) * 0.45;
    let rx0 = ((x0 - pad_x) / gw).clamp(0.0, 1.0);
    let ry0 = ((y0 - pad_y) / gh).clamp(0.0, 1.0);
    let rx1 = ((x1 + pad_x) / gw).clamp(0.0, 1.0);
    let ry1 = ((y1 + pad_y) / gh).clamp(0.0, 1.0);
    Some(FocusInfo {
        point: [
            (fx / sum_w / gw).clamp(0.0, 1.0),
            (fy / sum_w / gh).clamp(0.0, 1.0),
        ],
        region: [rx0, ry0, (rx1 - rx0).max(0.01), (ry1 - ry0).max(0.01)],
    })
}
