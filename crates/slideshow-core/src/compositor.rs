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
use vello_cpu::color::AlphaColor;
use vello_cpu::kurbo::{Affine, BezPath, Point, Shape};
use vello_cpu::peniko::{Extend, ImageQuality, ImageSampler};
use vello_cpu::{
    Image, ImageSource, Level, Pixmap, RenderContext, RenderSettings, Resources,
};

pub struct Renderer {
    pub text: TextRenderer,
    pub cache: MediaCache,
    ctx: RenderContext,
    resources: Resources,
    /// Small single-threaded context for downscaled blur backgrounds.
    blur_ctx: RenderContext,
    blur_resources: Resources,
}

/// Bilinear-sampled image paint, matching the old tiny-skia pattern blits.
fn image_paint(src: Arc<Pixmap>, quality: ImageQuality) -> Image {
    Image {
        image: ImageSource::Pixmap(src),
        sampler: ImageSampler {
            x_extend: Extend::Pad,
            y_extend: Extend::Pad,
            quality,
            alpha: 1.0,
        },
    }
}

fn rgba(color: Color) -> AlphaColor<vello_cpu::color::Srgb> {
    AlphaColor::from_rgba8(color.r, color.g, color.b, color.a)
}

impl Renderer {
    pub fn new(ffmpeg: Option<Ffmpeg>) -> Self {
        let level = Level::try_detect().unwrap_or(Level::baseline());
        // Extra worker threads; the main thread also renders.
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .saturating_sub(1)
            .min(7) as u16;
        let ctx = RenderContext::new_with(16, 16, RenderSettings { level, num_threads: workers });
        let blur_ctx =
            RenderContext::new_with(16, 16, RenderSettings { level, num_threads: 0 });
        Self {
            text: TextRenderer::new(),
            cache: MediaCache::new(ffmpeg),
            ctx,
            resources: Resources::default(),
            blur_ctx,
            blur_resources: Resources::default(),
        }
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
            return Ok(solid_frame(w, h, project.settings.background));
        };

        let current = self.render_slide(project, spec.slide, spec.local_t, w, h, reveal_texts)?;
        let frame = match spec.transition {
            None => current,
            Some(tr) => {
                let previous = match tr.from {
                    Some(idx) => {
                        self.render_slide(project, idx, tr.from_local_t, w, h, reveal_texts)?
                    }
                    // The intro: the first slide arrives out of the
                    // project background.
                    None => solid_frame(w, h, project.settings.background),
                };
                transitions::blend(previous, current, tr.kind, tr.progress)
            }
        };
        // The outro: the film leaves into the background at the very end.
        match timeline.outro_at(t) {
            Some((kind, progress)) => Ok(transitions::blend(
                frame,
                solid_frame(w, h, project.settings.background),
                kind,
                progress,
            )),
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
        self.ctx.reset_and_resize(w as u16, h as u16);

        match &slide.background {
            SlideBackground::Default => self.fill_bg(project.settings.background, w, h),
            SlideBackground::Color { color } => self.fill_bg(*color, w, h),
            SlideBackground::Blur { cell, sigma, dim } => {
                self.fill_bg(project.settings.background, w, h);
                if let Some(src) = slide
                    .cells
                    .get(*cell)
                    .and_then(|c| self.cell_pixels(c, slide, local_t).ok().flatten())
                {
                    self.draw_blurred_cover(&src, w, h, *sigma, *dim);
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
            self.draw_cell(cell, slide, *rect, progress, local_t, w, h);
        }

        for overlay in &slide.texts {
            let opacity =
                if reveal_texts { 1.0 } else { overlay.opacity_at(local_t, slide.duration) };
            self.text.draw_overlay(
                &mut self.ctx,
                &mut self.resources,
                overlay,
                opacity,
                project.settings.text_margin,
            );
        }

        let mut pm = Pixmap::new(w as u16, h as u16);
        self.ctx.flush();
        self.ctx.render(&mut pm, &mut self.resources);
        Ok(pm)
    }

    fn fill_bg(&mut self, color: Color, w: u32, h: u32) {
        self.ctx.set_transform(Affine::IDENTITY);
        self.ctx.set_paint(rgba(color));
        self.ctx
            .fill_rect(&vello_cpu::kurbo::Rect::new(0.0, 0.0, w as f64, h as f64));
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
        cell: &Cell,
        slide: &Slide,
        rect: Rect,
        progress: f32,
        local_t: f64,
        frame_w: u32,
        frame_h: u32,
    ) {
        let min_dim = frame_w.min(frame_h) as f32;
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
                // Motion on a contained ("whole photo") cell moves the whole
                // letterboxed box — never a crop inside a fixed box. Zooms
                // scale about the focus point; Ken Burns glides the box so
                // the crop window's center tracks the cell center. Both are
                // single continuous formulas, linear in the eased window.
                let move_whole = matches!(cell.fit, Fit::Contain)
                    && matches!(cell.motion, Motion::Zoom { .. } | Motion::KenBurns { .. });
                if move_whole {
                    // The margin defines the RESTING composition (base scale
                    // fits the margined cell), but the motion isn't caged by
                    // it: a lone photo may move through the margin up to the
                    // full frame. Group members still stop at their own cell.
                    let bound = if slide.cells.len() == 1 {
                        Rect::new(0.0, 0.0, frame_w as f32, frame_h as f32)
                    } else {
                        rect
                    };
                    let s0 = (rect.w / sw).min(rect.h / sh);
                    let s = s0 * (1.0 / win.w.max(0.01)).max(0.01);
                    let dw = sw * s;
                    let dh = sh * s;
                    let (dx, dy) = match &cell.motion {
                        Motion::Zoom { origin, .. } => {
                            // Pure scale about a fixed point: the focus point
                            // keeps its resting screen position and the photo
                            // grows around it.
                            let o = [origin[0].clamp(0.0, 1.0), origin[1].clamp(0.0, 1.0)];
                            let (dw0, dh0) = (sw * s0, sh * s0);
                            let p0x = rect.x + rect.w / 2.0 + (o[0] - 0.5) * dw0;
                            let p0y = rect.y + rect.h / 2.0 + (o[1] - 0.5) * dh0;
                            (p0x - o[0] * dw, p0y - o[1] * dh)
                        }
                        _ => {
                            // Ken Burns: the window's center rides the cell
                            // center, so a sliding window glides the whole
                            // box and a shrinking window scales it.
                            let cx = rect.x + rect.w / 2.0;
                            let cy = rect.y + rect.h / 2.0;
                            (
                                cx - (win.x + win.w / 2.0) * sw * s,
                                cy - (win.y + win.h / 2.0) * sh * s,
                            )
                        }
                    };
                    let full = Rect::new(dx, dy, dw, dh);
                    // The visible box clips against the motion bound.
                    let cx0 = full.x.max(bound.x);
                    let cy0 = full.y.max(bound.y);
                    let cx1 = (full.x + full.w).min(bound.x + bound.w);
                    let cy1 = (full.y + full.h).min(bound.y + bound.h);
                    let dest = Rect::new(cx0, cy0, (cx1 - cx0).max(1.0), (cy1 - cy0).max(1.0));
                    let t = Affine::translate((
                        (full.x + full.w / 2.0) as f64,
                        (full.y + full.h / 2.0) as f64,
                    )) * Affine::scale(s as f64)
                        * Affine::translate((-(sw as f64) / 2.0, -(sh as f64) / 2.0));
                    (dest, Some(t), None)
                } else {
                    let mut crop =
                        Rect::new(win.x * sw, win.y * sh, (win.w * sw).max(1.0), (win.h * sh).max(1.0));
                    let (dest, s) = match cell.fit {
                        Fit::Cover => (rect, (rect.w / crop.w).max(rect.h / crop.h)),
                        Fit::Smart => {
                            // Fill like Cover, but slide the visible window
                            // so the stored face region stays in frame —
                            // centered on it when possible, clamped to the
                            // motion window's bounds.
                            let s = (rect.w / crop.w).max(rect.h / crop.h);
                            let vw = rect.w / s;
                            let vh = rect.h / s;
                            let (fx, fy) = cell
                                .smart_focus
                                .map(|r| ((r.x + r.w / 2.0) * sw, (r.y + r.h / 2.0) * sh))
                                .unwrap_or((crop.x + crop.w / 2.0, crop.y + crop.h / 2.0));
                            let vx = (fx - vw / 2.0)
                                .clamp(crop.x, (crop.x + crop.w - vw).max(crop.x));
                            let vy = (fy - vh / 2.0)
                                .clamp(crop.y, (crop.y + crop.h - vh).max(crop.y));
                            crop = Rect::new(vx, vy, vw.max(1.0), vh.max(1.0));
                            (rect, s)
                        }
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
                    let t = Affine::translate((
                        (dest.x + dest.w / 2.0) as f64,
                        (dest.y + dest.h / 2.0) as f64,
                    )) * Affine::scale(s as f64)
                        * Affine::translate((
                            -((crop.x + crop.w / 2.0) as f64),
                            -((crop.y + crop.h / 2.0) as f64),
                        ));
                    (dest, Some(t), None)
                }
            }
        };

        let Some(path) = rounded_rect_path(dest.x, dest.y, dest.w, dest.h, radius) else {
            return;
        };

        // Rotation spins the finished cell — image, corners, and border
        // together — about the cell's center, so overlap and tilt compose.
        let canvas = if cell.rotation.abs() > 0.01 {
            Affine::rotate_about(
                (cell.rotation as f64).to_radians(),
                Point::new((rect.x + rect.w / 2.0) as f64, (rect.y + rect.h / 2.0) as f64),
            )
        } else {
            Affine::IDENTITY
        };
        self.ctx.set_transform(canvas);

        // An instant-print lip extends the frame below the photo; the frame
        // fills first so the photo sits on it, and the border strokes the
        // extended outline.
        let lip = cell.border.as_ref().map(|b| b.lip.max(0.0) * min_dim).unwrap_or(0.0);
        let frame_path = if lip > 0.5 {
            rounded_rect_path(dest.x, dest.y, dest.w, dest.h + lip, radius)
        } else {
            None
        };
        if let (Some(frame), Some(border)) = (&frame_path, &cell.border) {
            self.ctx.set_paint(rgba(border.color));
            self.ctx.fill_path(frame);
        }

        match (solid, &src, transform) {
            (Some(color), _, _) => {
                self.ctx.set_paint(rgba(color));
                self.ctx.fill_path(&path);
            }
            (None, Some(src), Some(t)) => {
                self.ctx.set_paint(image_paint(src.clone(), ImageQuality::Medium));
                self.ctx.set_paint_transform(t);
                self.ctx.fill_path(&path);
                self.ctx.reset_paint_transform();
            }
            _ => {
                self.ctx.set_transform(Affine::IDENTITY);
                return;
            }
        }

        if let Some(border) = &cell.border {
            let bw = (border.width.max(0.0) * min_dim).max(0.5);
            self.ctx.set_paint(rgba(border.color));
            self.ctx
                .set_stroke(vello_cpu::kurbo::Stroke::new(bw as f64));
            self.ctx.stroke_path(frame_path.as_ref().unwrap_or(&path));
        }
        self.ctx.set_transform(Affine::IDENTITY);
    }

    /// Cover-scale `src` over the whole frame, blurred and dimmed.
    fn draw_blurred_cover(&mut self, src: &Arc<Pixmap>, w: u32, h: u32, sigma: f32, dim: f32) {
        // Work at reduced size: blur cost drops and the upscale adds smoothing.
        let small_w = (w / 4).max(2);
        let small_h = (h / 4).max(2);

        let sw = src.width() as f32;
        let sh = src.height() as f32;
        let s = (small_w as f32 / sw).max(small_h as f32 / sh);
        let t = Affine::translate((small_w as f64 / 2.0, small_h as f64 / 2.0))
            * Affine::scale(s as f64)
            * Affine::translate((-(sw as f64) / 2.0, -(sh as f64) / 2.0));

        self.blur_ctx.reset_and_resize(small_w as u16, small_h as u16);
        self.blur_ctx.set_paint(image_paint(src.clone(), ImageQuality::Medium));
        self.blur_ctx.set_paint_transform(t);
        self.blur_ctx
            .fill_rect(&vello_cpu::kurbo::Rect::new(0.0, 0.0, small_w as f64, small_h as f64));
        let mut small = Pixmap::new(small_w as u16, small_h as u16);
        self.blur_ctx.flush();
        self.blur_ctx.render(&mut small, &mut self.blur_resources);

        let sigma_small = (sigma.max(0.0) * small_h as f32).round() as u32;
        if sigma_small > 0 {
            box_blur(&mut small, sigma_small.min(small_h / 2).max(1));
        }
        small.set_may_have_transparency(false);

        // Upscale back over the frame.
        let up = Affine::scale_non_uniform(
            w as f64 / small_w as f64,
            h as f64 / small_h as f64,
        );
        self.ctx.set_transform(Affine::IDENTITY);
        self.ctx.set_paint(image_paint(Arc::new(small), ImageQuality::Medium));
        self.ctx.set_paint_transform(up);
        self.ctx
            .fill_rect(&vello_cpu::kurbo::Rect::new(0.0, 0.0, w as f64, h as f64));
        self.ctx.reset_paint_transform();

        if dim > 0.0 {
            self.ctx
                .set_paint(AlphaColor::from_rgba8(0, 0, 0, (dim.clamp(0.0, 1.0) * 255.0) as u8));
            self.ctx
                .fill_rect(&vello_cpu::kurbo::Rect::new(0.0, 0.0, w as f64, h as f64));
        }
    }
}

fn scaled_dim(v: u32, scale: f32) -> u32 {
    (((v as f32 * scale.clamp(0.05, 1.0)).round() as u32) & !1).max(16)
}

/// A frame filled with one color.
pub(crate) fn solid_frame(w: u32, h: u32, color: Color) -> Pixmap {
    let mut pm = Pixmap::new(w as u16, h as u16);
    fill_all(&mut pm, color);
    pm
}

pub(crate) fn fill_all(pm: &mut Pixmap, color: Color) {
    // Premultiplied fill; opaque colors are the norm here.
    let px = [
        (color.r as u32 * color.a as u32 / 255) as u8,
        (color.g as u32 * color.a as u32 / 255) as u8,
        (color.b as u32 * color.a as u32 / 255) as u8,
        color.a,
    ];
    for chunk in pm.data_as_u8_slice_mut().chunks_exact_mut(4) {
        chunk.copy_from_slice(&px);
    }
    pm.set_may_have_transparency(color.a != 255);
}

/// Rounded-rect path (plain rect when radius ≈ 0).
pub(crate) fn rounded_rect_path(x: f32, y: f32, w: f32, h: f32, radius: f32) -> Option<BezPath> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let rect = vello_cpu::kurbo::Rect::new(
        x as f64,
        y as f64,
        (x + w) as f64,
        (y + h) as f64,
    );
    let r = radius.clamp(0.0, w.min(h) / 2.0) as f64;
    if r < 0.5 {
        return Some(rect.to_path(0.1));
    }
    Some(rect.to_rounded_rect(r).to_path(0.1))
}

/// Three-pass box blur ≈ gaussian. Operates on premultiplied RGBA in place.
fn box_blur(pm: &mut Pixmap, radius: u32) {
    let w = pm.width() as usize;
    let h = pm.height() as usize;
    let r = radius as usize;
    let data = pm.data_as_u8_slice_mut();
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
        let mut pm = Pixmap::new(64, 48);
        fill_all(&mut pm, Color::from_rgb(255, 255, 255));
        box_blur(&mut pm, 9);
        // A solid frame must stay solid after blurring.
        for px in pm.data_as_u8_slice().chunks_exact(4) {
            assert!(px[0] >= 250 && px[1] >= 250 && px[2] >= 250);
        }
    }

    /// Window wider than the row: every pixel clamps to the edge.
    #[test]
    fn box_blur_window_wider_than_image() {
        let mut pm = Pixmap::new(5, 4);
        fill_all(&mut pm, Color::from_rgb(128, 128, 128));
        box_blur(&mut pm, 16);
    }
}
