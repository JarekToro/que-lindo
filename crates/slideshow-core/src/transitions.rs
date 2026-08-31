//! Blend two fully rendered slide frames according to a transition.

use crate::model::{ease_in_out, Direction, TransitionKind};
use tiny_skia::{BlendMode, FilterQuality, Paint, Pixmap, PixmapPaint, Transform};

/// `previous` is the outgoing slide, `current` the incoming one.
/// `progress` runs 0..1 over the transition window.
pub fn blend(
    mut previous: Pixmap,
    current: Pixmap,
    kind: TransitionKind,
    progress: f32,
) -> Pixmap {
    let p = progress.clamp(0.0, 1.0);
    let w = previous.width() as f32;
    let h = previous.height() as f32;
    match kind {
        TransitionKind::Cut => current,
        TransitionKind::CrossFade => {
            let paint = PixmapPaint {
                opacity: ease_in_out(p),
                blend_mode: BlendMode::SourceOver,
                quality: FilterQuality::Nearest,
            };
            previous.draw_pixmap(0, 0, current.as_ref(), &paint, Transform::identity(), None);
            previous
        }
        TransitionKind::FadeBlack | TransitionKind::FadeWhite => {
            let veil = if matches!(kind, TransitionKind::FadeBlack) {
                (0, 0, 0)
            } else {
                (255, 255, 255)
            };
            let (mut base, alpha) = if p < 0.5 {
                (previous, p * 2.0)
            } else {
                (current, (1.0 - p) * 2.0)
            };
            let mut paint = Paint::default();
            paint.set_color_rgba8(veil.0, veil.1, veil.2, (alpha.clamp(0.0, 1.0) * 255.0) as u8);
            if let Some(rect) = tiny_skia::Rect::from_xywh(0.0, 0.0, w, h) {
                base.fill_rect(rect, &paint, Transform::identity(), None);
            }
            base
        }
        TransitionKind::Slide { dir } => {
            let e = 1.0 - ease_in_out(p);
            let (dx, dy) = match dir {
                Direction::Left => (e * w, 0.0),
                Direction::Right => (-e * w, 0.0),
                Direction::Up => (0.0, e * h),
                Direction::Down => (0.0, -e * h),
            };
            let paint = PixmapPaint {
                opacity: 1.0,
                blend_mode: BlendMode::SourceOver,
                quality: FilterQuality::Nearest,
            };
            previous.draw_pixmap(
                dx.round() as i32,
                dy.round() as i32,
                current.as_ref(),
                &paint,
                Transform::identity(),
                None,
            );
            previous
        }
        TransitionKind::Wipe { dir } => {
            let e = ease_in_out(p);
            let (x, y, rw, rh) = match dir {
                Direction::Left => (w * (1.0 - e), 0.0, w * e, h),
                Direction::Right => (0.0, 0.0, w * e, h),
                Direction::Up => (0.0, h * (1.0 - e), w, h * e),
                Direction::Down => (0.0, 0.0, w, h * e),
            };
            let mut mask = tiny_skia::Mask::new(previous.width(), previous.height()).unwrap();
            if let Some(rect) = tiny_skia::Rect::from_xywh(x, y, rw.max(0.0), rh.max(0.0)) {
                let path = tiny_skia::PathBuilder::from_rect(rect);
                mask.fill_path(&path, tiny_skia::FillRule::Winding, false, Transform::identity());
            }
            let paint = PixmapPaint {
                opacity: 1.0,
                blend_mode: BlendMode::SourceOver,
                quality: FilterQuality::Nearest,
            };
            previous.draw_pixmap(0, 0, current.as_ref(), &paint, Transform::identity(), Some(&mask));
            previous
        }
    }
}
