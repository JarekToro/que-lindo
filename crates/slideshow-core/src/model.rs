//! Project document model. Serialized as versioned JSON (`.slideshow.json`).
//!
//! Conventions:
//! - Durations/times are seconds (f64).
//! - Sizes/offsets are *relative*: fractions of the frame (or of min(frame w,h)
//!   where noted) so a project renders identically at any export resolution.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;

pub const PROJECT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub slides: Vec<Slide>,
    #[serde(default)]
    pub audio: Vec<AudioTrack>,
}

fn default_version() -> u32 {
    PROJECT_VERSION
}

impl Default for Project {
    fn default() -> Self {
        Self {
            version: PROJECT_VERSION,
            settings: Settings::default(),
            slides: Vec::new(),
            audio: Vec::new(),
        }
    }
}

impl Project {
    pub fn from_json(json: &str) -> anyhow::Result<Self> {
        let p: Project = serde_json::from_str(json)?;
        if p.version > PROJECT_VERSION {
            anyhow::bail!(
                "project version {} is newer than supported version {}",
                p.version,
                PROJECT_VERSION
            );
        }
        Ok(p)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("project serializes")
    }

    /// All file paths referenced by the project (media + audio).
    pub fn referenced_paths(&self) -> Vec<&PathBuf> {
        let mut out = Vec::new();
        for s in &self.slides {
            for c in &s.cells {
                match &c.source {
                    MediaSource::Image { path } | MediaSource::Video { path, .. } => out.push(path),
                    MediaSource::Solid { .. } => {}
                }
            }
        }
        for a in &self.audio {
            out.push(&a.path);
        }
        out
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub background: Color,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30.0,
            background: Color::BLACK,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Slide {
    pub id: String,
    /// Seconds this slide is on screen (including any transition overlaps).
    pub duration: f64,
    pub layout: Layout,
    /// Outer margin as a fraction of min(frame w, h).
    pub margin: f32,
    /// Gap between cells as a fraction of min(frame w, h).
    pub gutter: f32,
    pub cells: Vec<Cell>,
    pub texts: Vec<TextOverlay>,
    /// Transition *into* this slide (ignored on the first slide).
    pub transition: Transition,
    pub background: SlideBackground,
}

impl Default for Slide {
    fn default() -> Self {
        Self {
            id: String::new(),
            duration: 5.0,
            layout: Layout::Single,
            margin: 0.0,
            gutter: 0.02,
            cells: Vec::new(),
            texts: Vec::new(),
            transition: Transition::default(),
            background: SlideBackground::default(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SlideBackground {
    /// Use the project background color.
    #[default]
    Default,
    Color {
        color: Color,
    },
    /// Blurred, cover-scaled copy of a cell's media behind the layout
    /// (the classic "blurred photo behind a portrait photo" look).
    Blur {
        #[serde(default)]
        cell: usize,
        /// Blur strength; sigma as a fraction of frame height.
        #[serde(default = "default_blur_sigma")]
        sigma: f32,
        /// 0..1 darkening applied over the blurred image so foreground pops.
        #[serde(default = "default_blur_dim")]
        dim: f32,
    },
}

fn default_blur_sigma() -> f32 {
    0.02
}
fn default_blur_dim() -> f32 {
    0.3
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Layout {
    #[default]
    Single,
    /// Horizontal bands. Empty `weights` = equal split per cell.
    Rows {
        #[serde(default)]
        weights: Vec<f32>,
    },
    /// Vertical bands. Empty `weights` = equal split per cell.
    Columns {
        #[serde(default)]
        weights: Vec<f32>,
    },
    Grid {
        rows: u32,
        cols: u32,
    },
    /// Cell 0 is large on `side`; remaining cells stack in the leftover strip.
    Featured {
        #[serde(default)]
        side: Side,
        /// Fraction of the frame given to the featured cell.
        #[serde(default = "default_featured_ratio")]
        ratio: f32,
    },
    /// Arbitrary normalized rectangles, one per cell.
    Custom {
        rects: Vec<NormRect>,
    },
}

fn default_featured_ratio() -> f32 {
    0.66
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    #[default]
    Left,
    Right,
    Top,
    Bottom,
}

/// Rectangle in normalized [0,1] coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct NormRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl NormRect {
    pub const FULL: NormRect = NormRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };

    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }

    /// Centered sub-rect covering `1/zoom` of the area (zoom=1.2 → 20% punch-in).
    pub fn zoomed(zoom: f32) -> Self {
        let s = 1.0 / zoom.max(0.01);
        Self { x: (1.0 - s) / 2.0, y: (1.0 - s) / 2.0, w: s, h: s }
    }

    pub fn lerp(a: NormRect, b: NormRect, t: f32) -> Self {
        Self {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            w: a.w + (b.w - a.w) * t,
            h: a.h + (b.h - a.h) * t,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Cell {
    pub source: MediaSource,
    pub fit: Fit,
    pub motion: Motion,
    /// Corner radius as a fraction of min(frame w, h).
    pub corner_radius: f32,
    pub border: Option<Border>,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            source: MediaSource::Solid { color: Color::from_rgb(40, 40, 40) },
            fit: Fit::Cover,
            motion: Motion::None,
            corner_radius: 0.0,
            border: None,
        }
    }
}

impl Cell {
    pub fn image(path: impl Into<PathBuf>) -> Self {
        Self { source: MediaSource::Image { path: path.into() }, ..Default::default() }
    }

    pub fn video(path: impl Into<PathBuf>) -> Self {
        Self {
            source: MediaSource::Video { path: path.into(), start: 0.0, mute: true },
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MediaSource {
    Image {
        path: PathBuf,
    },
    Video {
        path: PathBuf,
        /// Seek offset into the source clip, seconds.
        #[serde(default)]
        start: f64,
        /// Exclude this clip's audio from the export mix.
        #[serde(default = "default_true")]
        mute: bool,
    },
    Solid {
        color: Color,
    },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fit {
    /// Fill the cell, cropping overflow.
    #[default]
    Cover,
    /// Letterbox inside the cell.
    Contain,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Motion {
    #[default]
    None,
    /// Pan/zoom between two normalized crop windows of the *cell content*
    /// over the slide's duration.
    KenBurns { from: NormRect, to: NormRect },
    /// Centered zoom sugar: 1.0 = no zoom.
    Zoom { from: f32, to: f32 },
}

impl Motion {
    pub fn zoom_in(amount: f32) -> Self {
        Motion::Zoom { from: 1.0, to: amount }
    }
    pub fn zoom_out(amount: f32) -> Self {
        Motion::Zoom { from: amount, to: 1.0 }
    }

    /// Crop window at progress `t` (0..1), or None when motionless.
    pub fn window_at(&self, t: f32) -> Option<NormRect> {
        match self {
            Motion::None => None,
            Motion::KenBurns { from, to } => Some(NormRect::lerp(*from, *to, ease_in_out(t))),
            Motion::Zoom { from, to } => {
                let z = from + (to - from) * ease_in_out(t);
                Some(NormRect::zoomed(z))
            }
        }
    }
}

pub fn ease_in_out(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Border {
    /// Width as a fraction of min(frame w, h).
    pub width: f32,
    pub color: Color,
}

impl Default for Border {
    fn default() -> Self {
        Self { width: 0.004, color: Color::WHITE }
    }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TextOverlay {
    pub text: String,
    pub role: TextRole,
    /// Font family name; None = theme default for the role.
    pub font: Option<String>,
    /// CSS-style weight (400 normal, 700 bold).
    pub weight: u16,
    pub italic: bool,
    /// Font size as a fraction of frame height.
    pub size: f32,
    pub color: Color,
    pub align: Align,
    pub anchor: Anchor,
    /// Offset from the anchor, as fractions of frame (w, h).
    pub offset: [f32; 2],
    /// Wrap width as a fraction of frame width.
    pub max_width: f32,
    pub line_height: f32,
    pub shadow: bool,
    /// Optional pill/box behind the text.
    pub box_color: Option<Color>,
    /// Appear time relative to slide start, seconds.
    pub start: f64,
    /// Disappear time relative to slide start; None = until slide end.
    pub end: Option<f64>,
    /// Fade in/out duration, seconds.
    pub fade: f64,
}

impl Default for TextOverlay {
    fn default() -> Self {
        Self {
            text: String::new(),
            role: TextRole::Caption,
            font: None,
            weight: 400,
            italic: false,
            size: 0.045,
            color: Color::WHITE,
            align: Align::Center,
            anchor: Anchor::BottomCenter,
            offset: [0.0, -0.06],
            max_width: 0.85,
            line_height: 1.25,
            shadow: true,
            box_color: None,
            start: 0.0,
            end: None,
            fade: 0.35,
        }
    }
}

impl TextOverlay {
    /// Opacity of this overlay at slide-local time `t` given the slide duration.
    pub fn opacity_at(&self, t: f64, slide_duration: f64) -> f32 {
        let end = self.end.unwrap_or(slide_duration).min(slide_duration);
        if t < self.start || t >= end {
            return 0.0;
        }
        let fade = self.fade.max(0.0001);
        let fade_in = ((t - self.start) / fade).min(1.0);
        let fade_out = ((end - t) / fade).min(1.0);
        (fade_in.min(fade_out) as f32).clamp(0.0, 1.0)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextRole {
    Title,
    Subtitle,
    #[default]
    Caption,
    LowerThird,
    Credit,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Anchor {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    #[default]
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

impl Anchor {
    /// Normalized anchor point in the frame.
    pub fn point(&self) -> (f32, f32) {
        match self {
            Anchor::TopLeft => (0.0, 0.0),
            Anchor::TopCenter => (0.5, 0.0),
            Anchor::TopRight => (1.0, 0.0),
            Anchor::CenterLeft => (0.0, 0.5),
            Anchor::Center => (0.5, 0.5),
            Anchor::CenterRight => (1.0, 0.5),
            Anchor::BottomLeft => (0.0, 1.0),
            Anchor::BottomCenter => (0.5, 1.0),
            Anchor::BottomRight => (1.0, 1.0),
        }
    }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Transition {
    pub kind: TransitionKind,
    pub duration: f64,
}

impl Default for Transition {
    fn default() -> Self {
        Self { kind: TransitionKind::CrossFade, duration: 1.0 }
    }
}

impl Transition {
    pub fn cut() -> Self {
        Self { kind: TransitionKind::Cut, duration: 0.0 }
    }

    pub fn effective_duration(&self) -> f64 {
        match self.kind {
            TransitionKind::Cut => 0.0,
            _ => self.duration.max(0.0),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransitionKind {
    Cut,
    #[default]
    CrossFade,
    FadeBlack,
    FadeWhite,
    Slide {
        #[serde(default)]
        dir: Direction,
    },
    Wipe {
        #[serde(default)]
        dir: Direction,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    #[default]
    Left,
    Right,
    Up,
    Down,
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioTrack {
    pub path: PathBuf,
    /// Placement on the timeline, seconds.
    #[serde(default)]
    pub start: f64,
    /// Seek offset into the source file, seconds.
    #[serde(default)]
    pub offset: f64,
    /// Max length taken from the file; None = to the file's end.
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub gain_db: f32,
    #[serde(default = "default_audio_fade")]
    pub fade_in: f64,
    #[serde(default = "default_audio_fade")]
    pub fade_out: f64,
    /// Loop the track until the end of the video.
    #[serde(default, rename = "loop")]
    pub loop_: bool,
}

fn default_audio_fade() -> f64 {
    0.0
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/// RGBA color, serialized as `"#rrggbb"` or `"#rrggbbaa"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    pub const BLACK: Color = Color { r: 0, g: 0, b: 0, a: 255 };
    pub const WHITE: Color = Color { r: 255, g: 255, b: 255, a: 255 };

    pub const fn from_rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255 }
    }

    pub const fn from_rgba(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }

    pub fn parse(s: &str) -> Option<Self> {
        let s = s.strip_prefix('#')?;
        let v = |i: usize| u8::from_str_radix(s.get(i..i + 2)?, 16).ok();
        match s.len() {
            6 => Some(Self { r: v(0)?, g: v(2)?, b: v(4)?, a: 255 }),
            8 => Some(Self { r: v(0)?, g: v(2)?, b: v(4)?, a: v(6)? }),
            _ => None,
        }
    }

    pub fn to_hex(&self) -> String {
        if self.a == 255 {
            format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
        } else {
            format!("#{:02x}{:02x}{:02x}{:02x}", self.r, self.g, self.b, self.a)
        }
    }
}

impl fmt::Display for Color {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl Serialize for Color {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        Color::parse(&s)
            .ok_or_else(|| serde::de::Error::custom(format!("invalid color {s:?}, expected #rrggbb or #rrggbbaa")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_roundtrip() {
        assert_eq!(Color::parse("#ff8000"), Some(Color::from_rgb(255, 128, 0)));
        assert_eq!(Color::parse("#ff800080"), Some(Color::from_rgba(255, 128, 0, 128)));
        assert_eq!(Color::parse("bad"), None);
        assert_eq!(Color::from_rgb(1, 2, 3).to_hex(), "#010203");
    }

    #[test]
    fn project_json_roundtrip() {
        let mut p = Project::default();
        p.slides.push(Slide {
            id: "s1".into(),
            duration: 4.0,
            layout: Layout::Grid { rows: 2, cols: 2 },
            cells: vec![Cell::image("a.jpg"), Cell::video("b.mp4")],
            texts: vec![TextOverlay { text: "Hello".into(), ..Default::default() }],
            transition: Transition { kind: TransitionKind::Slide { dir: Direction::Left }, duration: 0.8 },
            ..Default::default()
        });
        p.audio.push(AudioTrack {
            path: "music.mp3".into(),
            start: 0.0,
            offset: 1.5,
            duration: None,
            gain_db: -3.0,
            fade_in: 2.0,
            fade_out: 3.0,
            loop_: true,
        });
        let json = p.to_json();
        let p2 = Project::from_json(&json).unwrap();
        assert_eq!(p2.slides.len(), 1);
        assert_eq!(p2.slides[0].layout, Layout::Grid { rows: 2, cols: 2 });
        assert_eq!(p2.to_json(), json);
    }

    #[test]
    fn text_opacity_fades() {
        let t = TextOverlay { start: 1.0, end: Some(3.0), fade: 0.5, ..Default::default() };
        assert_eq!(t.opacity_at(0.5, 5.0), 0.0);
        assert!((t.opacity_at(1.25, 5.0) - 0.5).abs() < 1e-4);
        assert_eq!(t.opacity_at(2.0, 5.0), 1.0);
        assert!((t.opacity_at(2.75, 5.0) - 0.5).abs() < 1e-4);
        assert_eq!(t.opacity_at(3.5, 5.0), 0.0);
    }
}
