//! Layout spec → pixel rectangles for each cell.

use crate::model::{Layout, NormRect, Side};

/// Pixel-space rectangle (f32 for sub-pixel layout math).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }
}

/// Compute one rect per cell (up to `n_cells`) inside a `frame_w`×`frame_h`
/// frame. `margin` and `gutter` are fractions of min(frame_w, frame_h).
pub fn layout_rects(
    layout: &Layout,
    n_cells: usize,
    frame_w: f32,
    frame_h: f32,
    margin: f32,
    gutter: f32,
) -> Vec<Rect> {
    if n_cells == 0 {
        return Vec::new();
    }
    let min_dim = frame_w.min(frame_h);
    let m = margin.max(0.0) * min_dim;
    let g = gutter.max(0.0) * min_dim;
    let area = Rect::new(m, m, (frame_w - 2.0 * m).max(1.0), (frame_h - 2.0 * m).max(1.0));

    match layout {
        Layout::Single => vec![area; n_cells.min(1)],
        Layout::Rows { weights } => split(area, n_cells, weights, g, false),
        Layout::Columns { weights } => split(area, n_cells, weights, g, true),
        Layout::Grid { rows, cols } => grid(area, n_cells, *rows as usize, *cols as usize, g),
        Layout::Featured { side, ratio } => featured(area, n_cells, *side, *ratio, g),
        Layout::Custom { rects } => rects
            .iter()
            .take(n_cells)
            .map(|r| {
                Rect::new(
                    area.x + r.x * area.w,
                    area.y + r.y * area.h,
                    r.w * area.w,
                    r.h * area.h,
                )
            })
            .collect(),
    }
}

/// Split `area` into `n` bands. `vertical == true` splits along x (columns).
fn split(area: Rect, n: usize, weights: &[f32], gutter: f32, vertical: bool) -> Vec<Rect> {
    let n = n.max(1);
    let w: Vec<f32> = (0..n)
        .map(|i| weights.get(i).copied().filter(|v| *v > 0.0).unwrap_or(1.0))
        .collect();
    let total: f32 = w.iter().sum();
    let span = if vertical { area.w } else { area.h } - gutter * (n as f32 - 1.0);
    let span = span.max(1.0);

    let mut out = Vec::with_capacity(n);
    let mut cursor = if vertical { area.x } else { area.y };
    for wi in &w {
        let size = span * wi / total;
        if vertical {
            out.push(Rect::new(cursor, area.y, size, area.h));
        } else {
            out.push(Rect::new(area.x, cursor, area.w, size));
        }
        cursor += size + gutter;
    }
    out
}

fn grid(area: Rect, n: usize, rows: usize, cols: usize, gutter: f32) -> Vec<Rect> {
    let rows = rows.max(1);
    let cols = cols.max(1);
    let n = n.min(rows * cols);
    let cw = (area.w - gutter * (cols as f32 - 1.0)) / cols as f32;
    let ch = (area.h - gutter * (rows as f32 - 1.0)) / rows as f32;
    (0..n)
        .map(|i| {
            let r = i / cols;
            let c = i % cols;
            Rect::new(
                area.x + c as f32 * (cw + gutter),
                area.y + r as f32 * (ch + gutter),
                cw,
                ch,
            )
        })
        .collect()
}

fn featured(area: Rect, n: usize, side: Side, ratio: f32, gutter: f32) -> Vec<Rect> {
    if n == 1 {
        return vec![area];
    }
    let ratio = ratio.clamp(0.1, 0.9);
    let horizontal = matches!(side, Side::Left | Side::Right);
    let (main, strip) = if horizontal {
        let main_w = (area.w - gutter) * ratio;
        let strip_w = area.w - gutter - main_w;
        let (mx, sx) = match side {
            Side::Left => (area.x, area.x + main_w + gutter),
            _ => (area.x + strip_w + gutter, area.x),
        };
        (
            Rect::new(mx, area.y, main_w, area.h),
            Rect::new(sx, area.y, strip_w, area.h),
        )
    } else {
        let main_h = (area.h - gutter) * ratio;
        let strip_h = area.h - gutter - main_h;
        let (my, sy) = match side {
            Side::Top => (area.y, area.y + main_h + gutter),
            _ => (area.y + strip_h + gutter, area.y),
        };
        (
            Rect::new(area.x, my, area.w, main_h),
            Rect::new(area.x, sy, area.w, strip_h),
        )
    };
    let mut out = vec![main];
    // Stack the remaining cells along the strip's long axis.
    out.extend(split(strip, n - 1, &[], gutter, !horizontal));
    out
}

/// Normalized rects for UI layout pickers / thumbnails.
pub fn layout_preview(layout: &Layout, n_cells: usize) -> Vec<NormRect> {
    layout_rects(layout, n_cells, 1.0, 1.0, 0.0, 0.02)
        .into_iter()
        .map(|r| NormRect::new(r.x, r.y, r.w, r.h))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Layout;

    fn approx(a: f32, b: f32) {
        assert!((a - b).abs() < 0.01, "{a} != {b}");
    }

    #[test]
    fn single_fills_frame() {
        let r = layout_rects(&Layout::Single, 1, 1920.0, 1080.0, 0.0, 0.0);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], Rect::new(0.0, 0.0, 1920.0, 1080.0));
    }

    #[test]
    fn margin_insets_area() {
        let r = layout_rects(&Layout::Single, 1, 1920.0, 1080.0, 0.05, 0.0);
        approx(r[0].x, 54.0); // 0.05 * 1080
        approx(r[0].w, 1920.0 - 108.0);
    }

    #[test]
    fn columns_equal_split_with_gutter() {
        let r = layout_rects(&Layout::Columns { weights: vec![] }, 3, 1000.0, 500.0, 0.0, 0.02);
        assert_eq!(r.len(), 3);
        let g = 0.02 * 500.0; // 10px
        let w = (1000.0 - 2.0 * g) / 3.0;
        approx(r[0].w, w);
        approx(r[1].x, w + g);
        approx(r[2].x, 2.0 * (w + g));
        approx(r[2].x + r[2].w, 1000.0);
    }

    #[test]
    fn rows_weighted() {
        let r = layout_rects(&Layout::Rows { weights: vec![2.0, 1.0] }, 2, 900.0, 900.0, 0.0, 0.0);
        approx(r[0].h, 600.0);
        approx(r[1].h, 300.0);
        approx(r[1].y, 600.0);
    }

    #[test]
    fn grid_2x2() {
        let r = layout_rects(&Layout::Grid { rows: 2, cols: 2 }, 4, 1000.0, 1000.0, 0.0, 0.0);
        assert_eq!(r.len(), 4);
        approx(r[3].x, 500.0);
        approx(r[3].y, 500.0);
        // Fewer cells than grid slots → only that many rects.
        let r = layout_rects(&Layout::Grid { rows: 2, cols: 2 }, 3, 1000.0, 1000.0, 0.0, 0.0);
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn featured_left() {
        let r = layout_rects(
            &Layout::Featured { side: Side::Left, ratio: 0.66 },
            3,
            1000.0,
            600.0,
            0.0,
            0.0,
        );
        assert_eq!(r.len(), 3);
        approx(r[0].w, 660.0);
        approx(r[0].h, 600.0);
        approx(r[1].x, 660.0);
        approx(r[1].h, 300.0);
        approx(r[2].y, 300.0);
    }

    #[test]
    fn custom_rects_scale() {
        let r = layout_rects(
            &Layout::Custom { rects: vec![NormRect::new(0.25, 0.25, 0.5, 0.5)] },
            1,
            2000.0,
            1000.0,
            0.0,
            0.0,
        );
        assert_eq!(r[0], Rect::new(500.0, 250.0, 1000.0, 500.0));
    }
}
