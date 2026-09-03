//! Scene embeddings: a quantized CLIP vision tower over each photo, run
//! fully offline through ONNX Runtime. The embedding is the grouping
//! signal that survives what tone fingerprints can't — same moment shot
//! from different angles, same people across different rooms.
//!
//! The model file is optional: when it's absent every call returns None and
//! grouping falls back to the fingerprint + face-count rule. Lookup order:
//! `SLIDESHOW_EMBED_MODEL`, then `<app_data>/models/clip-vision-b32-int8.onnx`.

use image::imageops::FilterType;
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const SIDE: u32 = 224;
/// CLIP's channel normalization (mean, std).
const MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const STD: [f32; 3] = [0.268_629_54, 0.261_302_58, 0.275_777_11];

static SESSION: OnceLock<Option<Mutex<Session>>> = OnceLock::new();
static FACE_SESSION: OnceLock<Option<Mutex<Session>>> = OnceLock::new();

const FACE_SIDE: u32 = 160;

fn model_path(app_data: &Path) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SLIDESHOW_EMBED_MODEL") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let p = app_data.join("models/clip-vision-b32-int8.onnx");
    p.is_file().then_some(p)
}

fn session(app_data: &Path) -> Option<&'static Mutex<Session>> {
    SESSION
        .get_or_init(|| {
            let path = model_path(app_data)?;
            match Session::builder().and_then(|mut b| b.commit_from_file(&path)) {
                Ok(s) => Some(Mutex::new(s)),
                Err(e) => {
                    log::warn!("embed model failed to load from {}: {e}", path.display());
                    None
                }
            }
        })
        .as_ref()
}

/// Whether an embedding model is available (drives frontend gating).
pub fn available(app_data: &Path) -> bool {
    session(app_data).is_some()
}

fn face_session(app_data: &Path) -> Option<&'static Mutex<Session>> {
    FACE_SESSION
        .get_or_init(|| {
            let path = app_data.join("models/facenet-vggface2.onnx");
            if !path.is_file() {
                return None;
            }
            match Session::builder().and_then(|mut b| b.commit_from_file(&path)) {
                Ok(s) => Some(Mutex::new(s)),
                Err(e) => {
                    log::warn!("face model failed to load from {}: {e}", path.display());
                    None
                }
            }
        })
        .as_ref()
}

/// L2-normalized identity embedding per detected face, from frame-fraction
/// boxes. Empty when the model is absent, the image is unreadable, or no
/// boxes were given.
pub fn embed_faces(app_data: &Path, path: &Path, boxes: &[[f32; 4]]) -> Vec<Vec<f32>> {
    let Some(sess) = face_session(app_data) else {
        return Vec::new();
    };
    if boxes.is_empty() {
        return Vec::new();
    }
    let Ok(img) = image::open(path) else {
        return Vec::new();
    };
    let (iw, ih) = (img.width() as f32, img.height() as f32);
    let mut out = Vec::new();
    for b in boxes {
        // A small margin around the detector's box; the embedder was trained
        // on detector crops and tolerates loose framing.
        let m = 0.1;
        let x0 = ((b[0] - b[2] * m) * iw).max(0.0) as u32;
        let y0 = ((b[1] - b[3] * m) * ih).max(0.0) as u32;
        let x1 = (((b[0] + b[2] * (1.0 + m)) * iw) as u32).min(img.width());
        let y1 = (((b[1] + b[3] * (1.0 + m)) * ih) as u32).min(img.height());
        if x1 <= x0 + 4 || y1 <= y0 + 4 {
            continue;
        }
        let crop = img
            .crop_imm(x0, y0, x1 - x0, y1 - y0)
            .resize_exact(FACE_SIDE, FACE_SIDE, FilterType::Triangle)
            .into_rgb8();
        let mut data = vec![0f32; (3 * FACE_SIDE * FACE_SIDE) as usize];
        let plane = (FACE_SIDE * FACE_SIDE) as usize;
        for (i, px) in crop.pixels().enumerate() {
            for c in 0..3 {
                data[c * plane + i] = (px.0[c] as f32 - 127.5) / 128.0;
            }
        }
        let Ok(input) =
            Tensor::from_array(([1usize, 3, FACE_SIDE as usize, FACE_SIDE as usize], data))
        else {
            continue;
        };
        let Ok(mut sess) = sess.lock() else { continue };
        let Ok(outputs) = sess.run(ort::inputs!["face" => input]) else {
            continue;
        };
        if let Ok((_, e)) = outputs["embedding"].try_extract_tensor::<f32>() {
            out.push(e.to_vec());
        }
    }
    out
}

/// L2-normalized scene embedding of the image at `path`, or None when the
/// model is absent or the file can't be read as an image.
pub fn embed(app_data: &Path, path: &Path) -> Option<Vec<f32>> {
    let sess = session(app_data)?;
    let img = image::open(path).ok()?;
    // Shortest side to 224, center crop — CLIP's canonical preprocessing.
    let (w, h) = (img.width().max(1), img.height().max(1));
    let scale = SIDE as f32 / w.min(h) as f32;
    let (rw, rh) = (
        (w as f32 * scale).round() as u32,
        (h as f32 * scale).round() as u32,
    );
    let resized = img.resize_exact(rw.max(SIDE), rh.max(SIDE), FilterType::CatmullRom);
    let x0 = (resized.width() - SIDE) / 2;
    let y0 = (resized.height() - SIDE) / 2;
    let crop = resized.crop_imm(x0, y0, SIDE, SIDE).into_rgb8();

    let mut data = vec![0f32; (3 * SIDE * SIDE) as usize];
    let plane = (SIDE * SIDE) as usize;
    for (i, px) in crop.pixels().enumerate() {
        for c in 0..3 {
            data[c * plane + i] = (px.0[c] as f32 / 255.0 - MEAN[c]) / STD[c];
        }
    }

    let input = Tensor::from_array(([1usize, 3, SIDE as usize, SIDE as usize], data)).ok()?;
    let mut sess = sess.lock().ok()?;
    let outputs = sess.run(ort::inputs!["pixel_values" => input]).ok()?;
    let (_, out) = outputs["embedding"].try_extract_tensor::<f32>().ok()?;
    Some(out.to_vec())
}
