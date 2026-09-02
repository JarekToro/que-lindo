//! Frame compositor: renders any instant of the project to pixels.
//! The same code path serves GUI preview and export, so they cannot disagree.

use crate::layout::{layout_rects, Rect};
use crate::media::{Ffmpeg, MediaCache};
use crate::model::*;
use crate::text::TextRenderer;
use crate::timeline::Timeline;
use crate::transitions;
use anyhow::Result;
use std::sync::Arc;
use tiny_skia::{
    FillRule, FilterQuality, Paint, PathBuilder, Pattern, Pixmap, SpreadMode, Stroke, Transform,
};

pub struct Renderer {
    pub text: TextRenderer,
    pub cache: MediaCache,
}

impl Renderer {
    pub fn new(ffmpeg: Option<Ffmpeg>) -> Self {
        Self { text: TextRenderer::new(), cache: MediaCache::new(ffmpeg) }
    }

    /// Render the frame at global time `t`. `scale` (0..1] shrinks the output
    /// for fast previews; 1.0 renders at full project resolution.
    pub fn render_frame(
        &mut self,
        project: &Project,
        timeline: &Timeline,
        t: f64,
        scale: f32,
    ) -> Result<Pixmap> {
        self.render_frame_opts(project, timeline, t, scale, false)
    }

    /// Like `render_frame`; `reveal_texts` draws every text overlay at full
    /// opacity regardless of its timing — the editing view uses it so a
    /// title being placed is visible even before its fade-in. Export never
    /// sets it.
    pub fn render_frame_opts(
        &mut self,
        project: &Project,
        timeline: &Timeline,
        t: f64,
        scale: f32,
        reveal_texts: bool,
    ) -> Result<Pixmap> {
        let w = scaled_dim(project.settings.width, scale);
        let h = scaled_dim(project.settings.height, scale);

        let Some(spec) = timeline.sample(t) else {
            let mut pm = Pixmap::new(w, h).unwrap();
            fill_all(&mut pm, project.settings.background);
            return Ok(pm);
        };

        let current = self.render_slide(project, spec.slide, spec.local_t, w, h, reveal_texts)?;
        let bg_frame = || {
            let mut pm = Pixmap::new(w, h).unwrap();
            fill_all(&mut pm, project.settings.background);
            pm
        };
        let frame = match spec.transition {
            None => current,
            Some(tr) => {
                let previous = match tr.from {
                    Some(idx) => {
                        self.render_slide(project, idx, tr.from_local_t, w, h, reveal_texts)?
                    }
                    // The intro: the first slide arrives out of the
                    // project background.
                    None => bg_frame(),
                };
                transitions::blend(previous, current, tr.kind, tr.progress)
            }
        };
        // The outro: the film leaves into the background at the very end.
        match timeline.outro_at(t) {
            Some((kind, progress)) => Ok(transitions::blend(frame, bg_frame(), kind, progress)),
            None => Ok(frame),
        }
    }

    fn render_slide(
        &mut self,
        project: &Project,
        idx: usize,
        local_t: f64,
        w: u32,
        h: u32,
        reveal_texts: bool,
    ) -> Result<Pixmap> {
        let slide = &project.slides[idx];
        let mut pm = Pixmap::new(w, h).unwrap();

        match &slide.background {
            SlideBackground::Default => fill_all(&mut pm, project.settings.background),
            SlideBackground::Color { color } => fill_all(&mut pm, *color),
            SlideBackground::Blur { cell, sigma, dim } => {
                fill_all(&mut pm, project.settings.background);
                if let Some(src) = slide
                    .cells
                    .get(*cell)
                    .and_then(|c| self.cell_pixels(c, slide, local_t).ok().flatten())
                {
                    draw_blurred_cover(&mut pm, &src, *sigma, *dim);
                }
            }
        }

        let rects = layout_rects(
            &slide.layout,
            slide.cells.len(),
            w as f32,
            h as f32,
            slide.margin,
            slide.gutter,
        );
        let progress = (local_t / slide.duration.max(0.001)).clamp(0.0, 1.0) as f32;
        for (cell, rect) in slide.cells.iter().zip(rects.iter()) {
            self.draw_cell(&mut pm, cell, slide, *rect, progress, local_t);
        }

        for overlay in &slide.texts {
            let opacity =
                if reveal_texts { 1.0 } else { overlay.opacity_at(local_t, slide.duration) };
            self.text.draw_overlay(&mut pm, overlay, opacity, project.settings.text_margin);
        }
        Ok(pm)
    }

    /// Source pixels for a cell at slide-local time (None for solids).
    fn cell_pixels(&mut self, cell: &Cell, _slide: &Slide, local_t: f64) -> Result<Option<Arc<Pixmap>>> {
        match &cell.source {
            MediaSource::Image { path } => Ok(Some(self.cache.image(path)?)),
            MediaSource::Video { path, start, .. } => {
                // Sample the clip at a fixed rate independent of preview scale.
                let fps = 30.0;
                Ok(Some(self.cache.video_frame(path, start + local_t, fps)?))
            }
            MediaSource::Solid { .. } => Ok(None),
        }
    }

    fn draw_cell(
        &mut self,
        pm: &mut Pixmap,
        cell: &Cell,
        slide: &Slide,
        rect: Rect,
        progress: f32,
        local_t: f64,
    ) {
        let min_dim = (pm.width().min(pm.height())) as f32;
        let radius = (cell.corner_radius.max(0.0) * min_dim).min(rect.w.min(rect.h) / 2.0);

        let src = match self.cell_pixels(cell, slide, local_t) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("media unavailable for cell: {e:#}");
                None
            }
        };

        let (dest, transform, solid) = match (&cell.source, &src) {
            (MediaSource::Solid { color }, _) => (rect, None, Some(*color)),
            // Missing/unreadable media → placeholder fill.
            (_, None) => (rect, None, Some(Color::from_rgb(60, 60, 60))),
            (_, Some(src)) => {
                let sw = src.width() as f32;
                let sh = src.height() as f32;
                let win = cell.motion.window_at(progress).unwrap_or(NormRect::FULL);
                // A zoom on a contained ("whole photo") cell scales the whole
                // letterboxed box toward the frame instead of magnifying and
                // cropping inside a fixed box — the photo stays whole until
                // it outgrows its cell.
                let zoom_whole = matches!(cell.fit, Fit::Contain)
                    && matches!(cell.motion, Motion::Zoom { .. });
                if zoom_whole {
                    let z = (1.0 / win.w.max(0.01)).max(0.01);
                    let s = (rect.w / sw).min(rect.h / sh) * z;
                    let dw = sw * s;
                    let dh = sh * s;
                    let origin = match &cell.motion {
                        Motion::Zoom { origin, .. } => *origin,
                        _ => [0.5, 0.5],
                    };
                    // Fits → centered. Overflowing → pull the focus point
                    // toward the cell center, never exposing a gap.
                    let dx = if dw <= rect.w {
                        rect.x + (rect.w - dw) / 2.0
                    } else {
                        (rect.x + rect.w / 2.0 - origin[0] * dw)
                            .clamp(rect.x + rect.w - dw, rect.x)
                    };
                    let dy = if dh <= rect.h {
                        rect.y + (rect.h - dh) / 2.0
                    } else {
                        (rect.y + rect.h / 2.0 - origin[1] * dh)
                            .clamp(rect.y + rect.h - dh, rect.y)
                    };
                    let full = Rect::new(dx, dy, dw, dh);
                    // The visible box clips against the cell.
                    let cx0 = full.x.max(rect.x);
                    let cy0 = full.y.max(rect.y);
                    let cx1 = (full.x + full.w).min(rect.x + rect.w);
                    let cy1 = (full.y + full.h).min(rect.y + rect.h);
                    let dest = Rect::new(cx0, cy0, (cx1 - cx0).max(1.0), (cy1 - cy0).max(1.0));
                    let t = Transform::from_translate(-sw / 2.0, -sh / 2.0)
                        .post_scale(s, s)
                        .post_translate(full.x + full.w / 2.0, full.y + full.h / 2.0);
                    (dest, Some(t), None)
                } else {
                    let crop =
                        Rect::new(win.x * sw, win.y * sh, (win.w * sw).max(1.0), (win.h * sh).max(1.0));
                    let (dest, s) = match cell.fit {
                        Fit::Cover => (rect, (rect.w / crop.w).max(rect.h / crop.h)),
                        Fit::Contain => {
                            let s = (rect.w / crop.w).min(rect.h / crop.h);
                            let dw = crop.w * s;
                            let dh = crop.h * s;
                            (
                                Rect::new(
                                    rect.x + (rect.w - dw) / 2.0,
                                    rect.y + (rect.h - dh) / 2.0,
                                    dw,
                                    dh,
                                ),
                                s,
                            )
                        }
                    };
                    // Map source pixels so the crop window's center lands on
                    // the destination center at uniform scale `s`.
                    let t = Transform::from_translate(-(crop.x + crop.w / 2.0), -(crop.y + crop.h / 2.0))
                        .post_scale(s, s)
                        .post_translate(dest.x + dest.w / 2.0, dest.y + dest.h / 2.0);
                    (dest, Some(t), None)
                }
            }
        };

        let Some(path) = rounded_rect_path(dest.x, dest.y, dest.w, dest.h, radius) else {
            return;
        };

        let mut paint = Paint::default();
        paint.anti_alias = true;
        match (solid, &src, transform) {
            (Some(color), _, _) => {
                paint.set_color_rgba8(color.r, color.g, color.b, color.a);
            }
            (None, Some(src), Some(t)) => {
                paint.shader = Pattern::new(
                    src.as_ref().as_ref(),
                    SpreadMode::Pad,
                    FilterQuality::Bilinear,
                    1.0,
                    t,
                );
            }
            _ => return,
        }
        pm.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);

        if let Some(border) = &cell.border {
            let bw = (border.width.max(0.0) * min_dim).max(0.5);
            let mut bp = Paint::default();
            bp.anti_alias = true;
            bp.set_color_rgba8(border.color.r, border.color.g, border.color.b, border.color.a);
            let stroke = Stroke { width: bw, ..Stroke::default() };
            pm.stroke_path(&path, &bp, &stroke, Transform::identity(), None);
        }
    }
}

fn scaled_dim(v: u32, scale: f32) -> u32 {
    (((v as f32 * scale.clamp(0.05, 1.0)).round() as u32) & !1).max(16)
}

pub(crate) fn fill_all(pm: &mut Pixmap, color: Color) {
    pm.fill(tiny_skia::Color::from_rgba8(color.r, color.g, color.b, color.a));
}

/// Rounded-rect path (plain rect when radius ≈ 0).
pub(crate) fn rounded_rect_path(x: f32, y: f32, w: f32, h: f32, radius: f32) -> Option<tiny_skia::Path> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let mut pb = PathBuilder::new();
    let r = radius.clamp(0.0, w.min(h) / 2.0);
    if r < 0.5 {
        pb.push_rect(tiny_skia::Rect::from_xywh(x, y, w, h)?);
        return pb.finish();
    }
    // Cubic approximation of quarter circles.
    const K: f32 = 0.5522848;
    let k = r * K;
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.cubic_to(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.cubic_to(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.cubic_to(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
    pb.line_to(x, y + r);
    pb.cubic_to(x, y + r - k, x + r - k, y, x + r, y);
    pb.close();
    pb.finish()
}

/// Cover-scale `src` over the whole frame, blurred and dimmed.
fn draw_blurred_cover(pm: &mut Pixmap, src: &Pixmap, sigma: f32, dim: f32) {
    let w = pm.width();
    let h = pm.height();
    // Work at reduced size: blur cost drops and the upscale adds smoothing.
    let small_w = (w / 4).max(2);
    let small_h = (h / 4).max(2);
    let mut small = Pixmap::new(small_w, small_h).unwrap();

    let sw = src.width() as f32;
    let sh = src.height() as f32;
    let s = (small_w as f32 / sw).max(small_h as f32 / sh);
    let t = Transform::from_translate(-sw / 2.0, -sh / 2.0)
        .post_scale(s, s)
        .post_translate(small_w as f32 / 2.0, small_h as f32 / 2.0);
    let mut paint = Paint::default();
    paint.shader = Pattern::new(src.as_ref(), SpreadMode::Pad, FilterQuality::Bilinear, 1.0, t);
    pm_fill_rect(&mut small, 0.0, 0.0, small_w as f32, small_h as f32, &paint);

    let sigma_small = (sigma.max(0.0) * small_h as f32).round() as u32;
    if sigma_small > 0 {
        box_blur(&mut small, sigma_small.min(small_h / 2).max(1));
    }

    // Upscale back over the frame.
    let up = Transform::from_scale(w as f32 / small_w as f32, h as f32 / small_h as f32);
    let mut paint = Paint::default();
    paint.shader = Pattern::new(small.as_ref(), SpreadMode::Pad, FilterQuality::Bilinear, 1.0, up);
    pm_fill_rect(pm, 0.0, 0.0, w as f32, h as f32, &paint);

    if dim > 0.0 {
        let mut p = Paint::default();
        p.set_color_rgba8(0, 0, 0, (dim.clamp(0.0, 1.0) * 255.0) as u8);
        pm_fill_rect(pm, 0.0, 0.0, w as f32, h as f32, &p);
    }
}

fn pm_fill_rect(pm: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, paint: &Paint) {
    if let Some(rect) = tiny_skia::Rect::from_xywh(x, y, w, h) {
        pm.fill_rect(rect, paint, Transform::identity(), None);
    }
}

/// Three-pass box blur ≈ gaussian. Operates on premultiplied RGBA in place.
fn box_blur(pm: &mut Pixmap, radius: u32) {
    let w = pm.width() as usize;
    let h = pm.height() as usize;
    let r = radius as usize;
    let data = pm.data_mut();
    let mut tmp = vec![0u8; data.len()];
    for _ in 0..3 {
        blur_pass(data, &mut tmp, w, h, r, true);
        blur_pass(&tmp, data, w, h, r, false);
    }
}

/// One directional pass; `horizontal` reads rows, else columns.
fn blur_pass(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, horizontal: bool) {
    let (outer, inner) = if horizontal { (h, w) } else { (w, h) };
    let idx = |o: usize, i: usize| -> usize {
        if horizontal {
            (o * w + i) * 4
        } else {
            (i * w + o) * 4
        }
    };
    let win = 2 * r + 1;
    let clamp = |j: isize| -> usize { j.clamp(0, inner as isize - 1) as usize };
    for o in 0..outer {
        // Clamp-to-edge window centered on i = 0: edge pixels enter with
        // their full multiplicity, so the sliding removals below never
        // subtract more than was added.
        let mut sums = [0u32; 4];
        for j in -(r as isize)..=(r as isize) {
            let p = idx(o, clamp(j));
            for c in 0..4 {
                sums[c] += src[p + c] as u32;
            }
        }
        for i in 0..inner {
            let center = idx(o, i);
            for c in 0..4 {
                dst[center + c] = (sums[c] / win as u32) as u8;
            }
            let add = idx(o, clamp(i as isize + r as isize + 1));
            let sub = idx(o, clamp(i as isize - r as isize));
            for c in 0..4 {
                sums[c] += src[add + c] as u32;
                sums[c] -= src[sub + c] as u32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bright edge pixels used to underflow the sliding window in debug
    /// builds (panic: subtract with overflow) and smear garbage in release.
    #[test]
    fn box_blur_survives_bright_edges() {
        let mut pm = Pixmap::new(64, 48).unwrap();
        fill_all(&mut pm, Color::from_rgb(255, 255, 255));
        box_blur(&mut pm, 9);
        // A solid frame must stay solid after blurring.
        for px in pm.pixels() {
            let c = px.demultiply();
            assert!(c.red() >= 250 && c.green() >= 250 && c.blue() >= 250);
        }
    }

    /// Window wider than the row: every pixel clamps to the edge.
    #[test]
    fn box_blur_window_wider_than_image() {
        let mut pm = Pixmap::new(5, 4).unwrap();
        fill_all(&mut pm, Color::from_rgb(128, 128, 128));
        box_blur(&mut pm, 16);
    }
}
