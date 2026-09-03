//! Blend two fully rendered slide frames according to a transition.
//! Frames are opaque premultiplied RGBA, so every blend reduces to plain
//! byte math — no rasterizer involved.

use crate::model::{ease_in_out, Direction, TransitionKind};
use vello_cpu::Pixmap;

/// `previous` is the outgoing slide, `current` the incoming one.
/// `progress` runs 0..1 over the transition window.
pub fn blend(
    mut previous: Pixmap,
    current: Pixmap,
    kind: TransitionKind,
    progress: f32,
) -> Pixmap {
    let p = progress.clamp(0.0, 1.0);
    let w = previous.width() as i64;
    let h = previous.height() as i64;
    match kind {
        TransitionKind::Cut => current,
        TransitionKind::CrossFade => {
            // Opaque frames: src-over at opacity o is a straight lerp.
            let o = (ease_in_out(p) * 255.0).round().clamp(0.0, 255.0) as u32;
            let inv = 255 - o;
            let dst = previous.data_as_u8_slice_mut();
            let src = current.data_as_u8_slice();
            for (d, s) in dst.iter_mut().zip(src.iter()) {
                *d = ((*s as u32 * o + *d as u32 * inv + 127) / 255) as u8;
            }
            previous
        }
        TransitionKind::FadeBlack | TransitionKind::FadeWhite => {
            let white = matches!(kind, TransitionKind::FadeWhite);
            let (mut base, alpha) = if p < 0.5 {
                (previous, p * 2.0)
            } else {
                (current, (1.0 - p) * 2.0)
            };
            let a = (alpha.clamp(0.0, 1.0) * 255.0) as u32;
            let inv = 255 - a;
            // Premultiplied veil: black is (0,0,0,a), white is (a,a,a,a).
            let veil = if white { [a, a, a, a] } else { [0, 0, 0, a] };
            for px in base.data_as_u8_slice_mut().chunks_exact_mut(4) {
                for c in 0..4 {
                    px[c] = (veil[c] + px[c] as u32 * inv / 255) as u8;
                }
            }
            base
        }
        TransitionKind::Slide { dir } => {
            let e = 1.0 - ease_in_out(p);
            let (dx, dy) = match dir {
                Direction::Left => ((e * w as f32).round() as i64, 0),
                Direction::Right => (-(e * w as f32).round() as i64, 0),
                Direction::Up => (0, (e * h as f32).round() as i64),
                Direction::Down => (0, -(e * h as f32).round() as i64),
            };
            copy_region(&mut previous, &current, dx, dy, 0, 0, w, h);
            previous
        }
        TransitionKind::Wipe { dir } => {
            let e = ease_in_out(p);
            let (x, y, rw, rh) = match dir {
                Direction::Left => (w as f32 * (1.0 - e), 0.0, w as f32 * e, h as f32),
                Direction::Right => (0.0, 0.0, w as f32 * e, h as f32),
                Direction::Up => (0.0, h as f32 * (1.0 - e), w as f32, h as f32 * e),
                Direction::Down => (0.0, 0.0, w as f32, h as f32 * e),
            };
            copy_region(
                &mut previous,
                &current,
                0,
                0,
                x.round() as i64,
                y.round() as i64,
                rw.round().max(0.0) as i64,
                rh.round().max(0.0) as i64,
            );
            previous
        }
    }
}

/// Copy the axis-aligned window (`rx`,`ry`,`rw`,`rh`) of `src` into `dst`
/// offset by (`dx`,`dy`), clipped to both frames. Frames are opaque, so a
/// row memcpy replaces src-over.
fn copy_region(
    dst: &mut Pixmap,
    src: &Pixmap,
    dx: i64,
    dy: i64,
    rx: i64,
    ry: i64,
    rw: i64,
    rh: i64,
) {
    let w = dst.width() as i64;
    let h = dst.height() as i64;
    let x0 = rx.max(0).max(-dx);
    let y0 = ry.max(0).max(-dy);
    let x1 = (rx + rw).min(w).min(w - dx);
    let y1 = (ry + rh).min(h).min(h - dy);
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let row_bytes = ((x1 - x0) * 4) as usize;
    let s = src.data_as_u8_slice();
    let d = dst.data_as_u8_slice_mut();
    for y in y0..y1 {
        let si = ((y * w + x0) * 4) as usize;
        let di = (((y + dy) * w + x0 + dx) * 4) as usize;
        d[di..di + row_bytes].copy_from_slice(&s[si..si + row_bytes]);
    }
}
