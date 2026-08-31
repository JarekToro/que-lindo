//! Timeline math: where each slide sits on the global clock, and what is on
//! screen at any instant. Transitions *overlap*: slide N+1 begins
//! `transition.duration` seconds before slide N ends.

use crate::model::{Project, TransitionKind};

#[derive(Debug, Clone)]
pub struct Timeline {
    /// Global start time of each slide.
    starts: Vec<f64>,
    /// Slide durations (copied so sampling needs no project reference).
    durations: Vec<f64>,
    /// Effective transition-in duration for each slide (0 for the first).
    trans_in: Vec<f64>,
    kinds: Vec<TransitionKind>,
    total: f64,
}

/// What is on screen at a sampled instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameSpec {
    /// Slide currently on screen (the incoming one during a transition).
    pub slide: usize,
    /// Time within that slide.
    pub local_t: f64,
    /// Set while transitioning from the previous slide.
    pub transition: Option<TransitionSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransitionSpec {
    /// Slide being left (== spec.slide - 1).
    pub from: usize,
    /// Local time within the outgoing slide.
    pub from_local_t: f64,
    /// 0..1 progress through the transition.
    pub progress: f32,
    pub kind: TransitionKind,
}

impl Timeline {
    pub fn new(project: &Project) -> Self {
        let n = project.slides.len();
        let mut starts = Vec::with_capacity(n);
        let mut durations = Vec::with_capacity(n);
        let mut trans_in = Vec::with_capacity(n);
        let mut kinds = Vec::with_capacity(n);
        let mut cursor = 0.0f64;

        for (i, slide) in project.slides.iter().enumerate() {
            let dur = slide.duration.max(0.1);
            let mut t_in = if i == 0 { 0.0 } else { slide.transition.effective_duration() };
            if i > 0 {
                // A transition can't outlast either slide it joins.
                let prev_dur = durations[i - 1];
                t_in = t_in.min(prev_dur * 0.5).min(dur * 0.5);
                cursor -= t_in;
            }
            starts.push(cursor);
            durations.push(dur);
            trans_in.push(t_in);
            kinds.push(if i == 0 { TransitionKind::Cut } else { slide.transition.kind });
            cursor += dur;
        }

        Self { starts, durations, trans_in, kinds, total: cursor.max(0.0) }
    }

    pub fn total_duration(&self) -> f64 {
        self.total
    }

    pub fn slide_start(&self, i: usize) -> f64 {
        self.starts[i]
    }

    pub fn slide_end(&self, i: usize) -> f64 {
        self.starts[i] + self.durations[i]
    }

    /// Effective duration of the transition into slide `i` (0 for the first).
    pub fn transition_in(&self, i: usize) -> f64 {
        self.trans_in[i]
    }

    pub fn num_slides(&self) -> usize {
        self.starts.len()
    }

    /// Which slide "owns" time t (the latest slide that has started).
    pub fn slide_at(&self, t: f64) -> Option<usize> {
        if self.starts.is_empty() {
            return None;
        }
        let mut cur = 0;
        for (i, &s) in self.starts.iter().enumerate() {
            if t >= s {
                cur = i;
            } else {
                break;
            }
        }
        Some(cur)
    }

    pub fn sample(&self, t: f64) -> Option<FrameSpec> {
        let i = self.slide_at(t)?;
        let t = t.clamp(0.0, self.total);
        let local_t = t - self.starts[i];
        let mut transition = None;
        if i > 0 && local_t < self.trans_in[i] && self.trans_in[i] > 0.0 {
            transition = Some(TransitionSpec {
                from: i - 1,
                from_local_t: t - self.starts[i - 1],
                progress: (local_t / self.trans_in[i]) as f32,
                kind: self.kinds[i],
            });
        }
        Some(FrameSpec { slide: i, local_t, transition })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Project, Slide, Transition, TransitionKind};

    fn proj(slides: Vec<(f64, f64)>) -> Project {
        // (duration, transition_in_duration)
        let mut p = Project::default();
        for (i, (dur, tr)) in slides.into_iter().enumerate() {
            p.slides.push(Slide {
                id: format!("s{i}"),
                duration: dur,
                transition: Transition { kind: TransitionKind::CrossFade, duration: tr },
                ..Default::default()
            });
        }
        p
    }

    #[test]
    fn empty_project() {
        let tl = Timeline::new(&Project::default());
        assert_eq!(tl.total_duration(), 0.0);
        assert!(tl.sample(0.0).is_none());
    }

    #[test]
    fn starts_overlap_by_transition() {
        let tl = Timeline::new(&proj(vec![(4.0, 0.0), (4.0, 1.0), (4.0, 2.0)]));
        assert_eq!(tl.slide_start(0), 0.0);
        assert_eq!(tl.slide_start(1), 3.0); // 4 - 1 overlap
        assert_eq!(tl.slide_start(2), 5.0); // 3 + 4 - 2 overlap
        assert_eq!(tl.total_duration(), 9.0);
    }

    #[test]
    fn transition_clamped_to_half_durations() {
        let tl = Timeline::new(&proj(vec![(1.0, 0.0), (4.0, 3.0)]));
        // 3s transition clamped to min(1*0.5, 4*0.5) = 0.5
        assert_eq!(tl.slide_start(1), 0.5);
    }

    #[test]
    fn sample_mid_slide_and_mid_transition() {
        let tl = Timeline::new(&proj(vec![(4.0, 0.0), (4.0, 1.0)]));
        // Plain middle of slide 0.
        let f = tl.sample(1.5).unwrap();
        assert_eq!(f.slide, 0);
        assert_eq!(f.local_t, 1.5);
        assert!(f.transition.is_none());

        // t=3.5 is halfway through the 1s crossfade into slide 1 (starts at 3.0).
        let f = tl.sample(3.5).unwrap();
        assert_eq!(f.slide, 1);
        assert!((f.local_t - 0.5).abs() < 1e-9);
        let tr = f.transition.unwrap();
        assert_eq!(tr.from, 0);
        assert!((tr.from_local_t - 3.5).abs() < 1e-9);
        assert!((tr.progress - 0.5).abs() < 1e-6);

        // After the transition window, no transition.
        let f = tl.sample(4.5).unwrap();
        assert_eq!(f.slide, 1);
        assert!(f.transition.is_none());
    }

    #[test]
    fn cut_has_no_overlap() {
        let mut p = proj(vec![(4.0, 0.0), (4.0, 1.0)]);
        p.slides[1].transition = Transition::cut();
        let tl = Timeline::new(&p);
        assert_eq!(tl.slide_start(1), 4.0);
        assert_eq!(tl.total_duration(), 8.0);
        assert!(tl.sample(4.2).unwrap().transition.is_none());
    }
}
