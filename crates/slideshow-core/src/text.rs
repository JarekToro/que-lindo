//! Text overlay rendering: cosmic-text shapes, wraps, and positions glyphs
//! (system fonts, fallback, BiDi); vello_cpu's glyph pipeline rasterizes
//! them directly into the scene with hinting and an atlas cache.

use crate::model::{Align, TextOverlay, TextRole};
use cosmic_text::{Attrs, Buffer, Family, FontSystem, Metrics, Shaping, Style, Weight};
use vello_cpu::color::AlphaColor;
use vello_cpu::{Glyph, RenderContext, Resources};

const CRIMSON_REGULAR: &[u8] = include_bytes!("../../../assets/fonts/CrimsonText-Regular.ttf");
const CRIMSON_SEMIBOLD: &[u8] = include_bytes!("../../../assets/fonts/CrimsonText-SemiBold.ttf");
const CRIMSON_ITALIC: &[u8] = include_bytes!("../../../assets/fonts/CrimsonText-Italic.ttf");
const LATO_REGULAR: &[u8] = include_bytes!("../../../assets/fonts/Lato-Regular.ttf");
const LATO_BOLD: &[u8] = include_bytes!("../../../assets/fonts/Lato-Bold.ttf");

pub const SERIF_FAMILY: &str = "Crimson Text";
pub const SANS_FAMILY: &str = "Lato";

pub struct TextRenderer {
    font_system: FontSystem,
}

/// Glyphs sharing one font face, positioned relative to the overlay origin.
struct GlyphGroup {
    font: cosmic_text::PenikoFont,
    font_size: f32,
    glyphs: Vec<Glyph>,
}

impl TextRenderer {
    pub fn new() -> Self {
        let mut font_system = FontSystem::new(); // loads system fonts
        let db = font_system.db_mut();
        for data in [CRIMSON_REGULAR, CRIMSON_SEMIBOLD, CRIMSON_ITALIC, LATO_REGULAR, LATO_BOLD] {
            db.load_font_data(data.to_vec());
        }
        Self { font_system }
    }

    pub fn font_families(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .font_system
            .db()
            .faces()
            .map(|f| f.families.first().map(|(n, _)| n.clone()).unwrap_or_default())
            // Dot-prefixed families are macOS-private UI fonts that neither
            // list nor render meaningfully.
            .filter(|n| !n.is_empty() && !n.starts_with('.'))
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// Draw `overlay` into `ctx` (sized to the frame) with the given overall
    /// opacity (0..1, from timing fades and transitions). `text_margin`
    /// insets the anchor regions from the frame edges (the title-safe area).
    pub fn draw_overlay(
        &mut self,
        ctx: &mut RenderContext,
        resources: &mut Resources,
        overlay: &TextOverlay,
        opacity: f32,
        text_margin: f32,
    ) {
        if overlay.text.trim().is_empty() || opacity <= 0.0 {
            return;
        }
        let frame_w = ctx.width() as f32;
        let frame_h = ctx.height() as f32;
        let font_size = (overlay.size * frame_h).max(4.0);
        let line_height = font_size * overlay.line_height.max(0.8);
        let wrap_w = (overlay.max_width.clamp(0.05, 1.0)) * frame_w;

        let family = overlay
            .font
            .clone()
            .unwrap_or_else(|| default_family(overlay.role).to_string());
        let attrs = Attrs::new()
            .family(Family::Name(&family))
            .weight(Weight(overlay.weight))
            .style(if overlay.italic { Style::Italic } else { Style::Normal });

        let align = match overlay.align {
            Align::Left => cosmic_text::Align::Left,
            Align::Center => cosmic_text::Align::Center,
            Align::Right => cosmic_text::Align::Right,
        };
        let mut buffer = Buffer::new(&mut self.font_system, Metrics::new(font_size, line_height));
        buffer.set_size(Some(wrap_w), None);
        buffer.set_text(&overlay.text, &attrs, Shaping::Advanced, Some(align));
        buffer.shape_until_scroll(&mut self.font_system, false);

        // Measure the laid-out text: tight bounds over the positioned glyphs
        // (glyph x already includes alignment within the wrap width).
        let (mut min_x, mut max_x, mut max_y) = (f32::MAX, 0.0f32, 0.0f32);
        for run in buffer.layout_runs() {
            for g in run.glyphs.iter() {
                min_x = min_x.min(g.x);
                max_x = max_x.max(g.x + g.w);
            }
            max_y = max_y.max(run.line_top + line_height);
        }
        if max_y <= 0.0 {
            return;
        }
        if min_x > max_x {
            min_x = 0.0;
            max_x = 0.0;
        }
        let text_w = max_x - min_x;
        let text_h = max_y;

        // Two independent layers, the way slide tools solve this: the text
        // FRAME (wrap width wide) is placed on the canvas by the anchor
        // region — its matching point sits on the region point, nudged by
        // the offset — while `align` only justifies the lines inside the
        // frame (the shaper already did that; glyph x is box-relative).
        let (ax, ay) = overlay.anchor.point();
        // The anchor regions live inside the title-safe area: edges and
        // corners are inset by the margin; center is unchanged.
        let m = text_margin.clamp(0.0, 0.2);
        let px = (m + ax * (1.0 - 2.0 * m)) * frame_w;
        let py = (m + ay * (1.0 - 2.0 * m)) * frame_h;
        let origin_x = px - ax * wrap_w + overlay.offset[0] * frame_w;
        let origin_y = py - ay * text_h + overlay.offset[1] * frame_h;

        // Optional backing box.
        if let Some(box_color) = overlay.box_color {
            let pad = font_size * 0.45;
            let r = crate::compositor::rounded_rect_path(
                origin_x + min_x - pad,
                origin_y - pad * 0.6,
                text_w + pad * 2.0,
                text_h + pad * 1.2,
                font_size * 0.25,
            );
            if let Some(path) = r {
                ctx.set_paint(AlphaColor::from_rgba8(
                    box_color.r,
                    box_color.g,
                    box_color.b,
                    (box_color.a as f32 * opacity) as u8,
                ));
                ctx.fill_path(&path);
            }
        }

        // Collect baseline-positioned glyphs, grouped per font face (fallback
        // may mix faces within a line).
        let mut groups: Vec<GlyphGroup> = Vec::new();
        let mut last_font: Option<(cosmic_text::fontdb::ID, u16)> = None;
        for run in buffer.layout_runs() {
            for g in run.glyphs.iter() {
                let glyph = Glyph {
                    id: g.glyph_id as u32,
                    x: origin_x + g.x + g.font_size * g.x_offset,
                    y: origin_y + run.line_y + g.y - g.font_size * g.y_offset,
                };
                let key = (g.font_id, g.font_weight.0);
                if last_font != Some(key) || groups.is_empty() {
                    let Some(font) = self.font_system.get_font(g.font_id, g.font_weight) else {
                        continue;
                    };
                    groups.push(GlyphGroup {
                        font: font.as_peniko(),
                        font_size: g.font_size,
                        glyphs: Vec::new(),
                    });
                    last_font = Some(key);
                }
                groups.last_mut().expect("pushed above").glyphs.push(glyph);
            }
        }

        // Drop shadow: same glyphs, offset, translucent black (the alpha
        // curve matches the old rasterizer: 160·opacity · 0.75·opacity).
        if overlay.shadow {
            let off = (font_size * 0.045).max(1.0);
            let a = (160.0 * opacity * 0.75 * opacity).clamp(0.0, 255.0) as u8;
            ctx.set_paint(AlphaColor::from_rgba8(0, 0, 0, a));
            for group in &groups {
                ctx.glyph_run(resources, &group.font)
                    .font_size(group.font_size)
                    .hint(true)
                    .fill_glyphs(
                        group
                            .glyphs
                            .iter()
                            .map(|g| Glyph { id: g.id, x: g.x + off, y: g.y + off }),
                    );
            }
        }

        let c = overlay.color;
        ctx.set_paint(AlphaColor::from_rgba8(
            c.r,
            c.g,
            c.b,
            (c.a as f32 * opacity) as u8,
        ));
        for group in &groups {
            ctx.glyph_run(resources, &group.font)
                .font_size(group.font_size)
                .hint(true)
                .fill_glyphs(group.glyphs.iter().copied());
        }
    }
}

impl Default for TextRenderer {
    fn default() -> Self {
        Self::new()
    }
}

pub fn default_family(role: TextRole) -> &'static str {
    match role {
        TextRole::Title | TextRole::Subtitle | TextRole::Credit => SERIF_FAMILY,
        TextRole::Caption | TextRole::LowerThird => SANS_FAMILY,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TextOverlay;
    use vello_cpu::{Pixmap, RenderSettings};

    fn render(tr: &mut TextRenderer, overlay: &TextOverlay, w: u16, h: u16) -> Pixmap {
        let settings = RenderSettings::default();
        let mut ctx = RenderContext::new_with(w, h, settings);
        let mut resources = Resources::default();
        tr.draw_overlay(&mut ctx, &mut resources, overlay, 1.0, 0.0);
        let mut pm = Pixmap::new(w, h);
        ctx.flush();
        ctx.render(&mut pm, &mut resources);
        pm
    }

    #[test]
    fn renders_visible_pixels() {
        let mut tr = TextRenderer::new();
        let overlay = TextOverlay {
            text: "In Loving Memory".into(),
            size: 0.1,
            ..Default::default()
        };
        let pm = render(&mut tr, &overlay, 640, 360);
        let lit = pm.data_as_u8_slice().chunks(4).filter(|p| p[3] > 0).count();
        assert!(lit > 500, "expected text pixels, got {lit}");
    }

    #[test]
    fn align_places_the_block_against_the_anchor() {
        use crate::model::{Align, Anchor};
        let mut tr = TextRenderer::new();
        let mut centroid = |align: Align| {
            let overlay = TextOverlay {
                text: "Names".into(),
                size: 0.1,
                anchor: Anchor::Center,
                align,
                shadow: false,
                ..Default::default()
            };
            let pm = render(&mut tr, &overlay, 640, 360);
            let (mut sum, mut n) = (0f64, 0f64);
            for (i, px) in pm.data_as_u8_slice().chunks(4).enumerate() {
                if px[3] > 0 {
                    sum += (i % 640) as f64;
                    n += 1.0;
                }
            }
            sum / n.max(1.0)
        };
        let left = centroid(Align::Left);
        let center = centroid(Align::Center);
        let right = centroid(Align::Right);
        // The frame stays put; align justifies the lines inside it: left
        // pushes the text to the frame's left edge, right to its right.
        assert!(left < center - 20.0, "left {left} vs center {center}");
        assert!(right > center + 20.0, "right {right} vs center {center}");
        assert!((center - 320.0).abs() < 30.0, "center {center}");
    }

    #[test]
    fn bundled_families_present() {
        let tr = TextRenderer::new();
        let fams = tr.font_families();
        assert!(fams.iter().any(|f| f == SERIF_FAMILY), "{fams:?}");
        assert!(fams.iter().any(|f| f == SANS_FAMILY));
    }
}
