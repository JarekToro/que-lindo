//! Builds the ffmpeg audio inputs + filter_complex for an export.

use crate::model::{AudioTrack, MediaSource, Project};
use crate::timeline::Timeline;
use crate::media::MediaCache;
use std::path::PathBuf;

/// One audio source feeding the mix.
#[derive(Debug, Clone)]
pub struct AudioInput {
    pub path: PathBuf,
    /// Prepend `-stream_loop -1` (music looped to fill the video).
    pub loop_input: bool,
    /// Seconds skipped at the head of the file.
    pub seek: f64,
    /// Seconds taken from the file after seeking.
    pub take: f64,
    /// Placement on the timeline, seconds.
    pub delay: f64,
    pub gain_db: f32,
    pub fade_in: f64,
    pub fade_out: f64,
}

/// Everything export needs to wire audio into the encode command.
#[derive(Debug, Clone, Default)]
pub struct AudioPlan {
    pub inputs: Vec<AudioInput>,
    /// filter_complex string producing `[aout]`; empty when there is no audio.
    pub filter: String,
}

/// Collect the project's audio tracks plus any unmuted video cells.
/// `cache` is used to probe durations (loops/fades need real lengths).
pub fn plan(project: &Project, timeline: &Timeline, cache: &mut MediaCache) -> AudioPlan {
    let total = timeline.total_duration();
    let mut inputs: Vec<AudioInput> = Vec::new();

    for track in &project.audio {
        if let Some(input) = plan_track(track, total, cache) {
            inputs.push(input);
        }
    }

    // Unmuted video clips contribute their own sound at their slide's position.
    for (i, slide) in project.slides.iter().enumerate() {
        for cell in &slide.cells {
            if let MediaSource::Video { path, start, mute: false } = &cell.source {
                let has_audio = cache.probe(path).map(|p| p.has_audio).unwrap_or(false);
                if !has_audio {
                    continue;
                }
                let slide_start = timeline.slide_start(i);
                inputs.push(AudioInput {
                    path: path.clone(),
                    loop_input: false,
                    seek: *start,
                    take: slide.duration.min(total - slide_start),
                    delay: slide_start,
                    gain_db: 0.0,
                    // Short ramps to avoid clicks at slide boundaries.
                    fade_in: 0.05,
                    fade_out: 0.05,
                });
            }
        }
    }

    let filter = build_filter(&inputs, total);
    AudioPlan { inputs, filter }
}

fn plan_track(track: &AudioTrack, total: f64, cache: &mut MediaCache) -> Option<AudioInput> {
    if track.start >= total {
        return None;
    }
    let window = total - track.start; // room left on the timeline
    let file_len = cache
        .probe(&track.path)
        .ok()
        .map(|p| p.duration)
        .filter(|d| *d > 0.0);
    let mut take = match (track.loop_, file_len) {
        (true, _) => window,
        (false, Some(len)) => (len - track.offset).max(0.0).min(window),
        (false, None) => window,
    };
    if let Some(d) = track.duration {
        take = take.min(d);
    }
    if take <= 0.01 {
        return None;
    }
    Some(AudioInput {
        path: track.path.clone(),
        loop_input: track.loop_,
        seek: track.offset,
        take,
        delay: track.start,
        gain_db: track.gain_db,
        fade_in: track.fade_in,
        fade_out: track.fade_out,
    })
}

/// Filtergraph: trim/gain/fade/delay each input, then mix and clamp to `total`.
/// Audio input N is ffmpeg input index N+1 (index 0 is the rawvideo pipe).
fn build_filter(inputs: &[AudioInput], total: f64) -> String {
    if inputs.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    for (i, input) in inputs.iter().enumerate() {
        let mut chain = vec![
            format!("[{}:a]", i + 1),
            // Uniform format first so amix never resamples mid-graph.
            "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo".to_string(),
            format!("atrim=start={:.4}:end={:.4}", input.seek, input.seek + input.take),
            "asetpts=PTS-STARTPTS".to_string(),
        ];
        if input.gain_db.abs() > 0.01 {
            chain.push(format!("volume={:.2}dB", input.gain_db));
        }
        if input.fade_in > 0.005 {
            chain.push(format!("afade=t=in:st=0:d={:.3}", input.fade_in));
        }
        if input.fade_out > 0.005 {
            let st = (input.take - input.fade_out).max(0.0);
            chain.push(format!("afade=t=out:st={:.3}:d={:.3}", st, input.fade_out));
        }
        if input.delay > 0.0005 {
            let ms = (input.delay * 1000.0).round() as i64;
            chain.push(format!("adelay={ms}|{ms}"));
        }
        parts.push(format!("{}{}[a{}]", chain[0], chain[1..].join(","), i));
    }
    let labels: String = (0..inputs.len()).map(|i| format!("[a{i}]")).collect();
    parts.push(format!(
        "{}amix=inputs={}:duration=longest:normalize=0,atrim=end={:.4}[aout]",
        labels,
        inputs.len(),
        total
    ));
    parts.join(";")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(delay: f64, take: f64) -> AudioInput {
        AudioInput {
            path: "a.mp3".into(),
            loop_input: false,
            seek: 0.0,
            take,
            delay,
            gain_db: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
        }
    }

    #[test]
    fn empty_plan_has_no_filter() {
        assert_eq!(build_filter(&[], 10.0), "");
    }

    #[test]
    fn single_input_graph() {
        let f = build_filter(&[input(0.0, 8.0)], 10.0);
        assert!(f.contains("[1:a]"), "{f}");
        assert!(f.contains("atrim=start=0.0000:end=8.0000"), "{f}");
        assert!(f.contains("amix=inputs=1"), "{f}");
        assert!(f.ends_with("[aout]"), "{f}");
        assert!(!f.contains("adelay"), "{f}");
    }

    #[test]
    fn delay_gain_fades() {
        let mut i = input(2.5, 6.0);
        i.gain_db = -3.0;
        i.fade_in = 1.0;
        i.fade_out = 2.0;
        let f = build_filter(&[i], 10.0);
        assert!(f.contains("volume=-3.00dB"), "{f}");
        assert!(f.contains("afade=t=in:st=0:d=1.000"), "{f}");
        assert!(f.contains("afade=t=out:st=4.000:d=2.000"), "{f}");
        assert!(f.contains("adelay=2500|2500"), "{f}");
    }

    #[test]
    fn mix_clamps_to_total() {
        let f = build_filter(&[input(0.0, 8.0), input(4.0, 20.0)], 12.0);
        assert!(f.contains("amix=inputs=2"), "{f}");
        assert!(f.contains("atrim=end=12.0000[aout]"), "{f}");
    }
}
