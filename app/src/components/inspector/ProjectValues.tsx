// Project & Music: the raw fields no selection can reach. Always present,
// collapsed by default — it survives empty projects and empty selections.

import { useEditor } from "../../store";
import type { AudioTrack, MediaItem, Project } from "../../types";
import { ColorField, NumField, Segmented, SliderField, VGroup } from "./fields";

/** Where the music bed ends on the timeline: the latest end across all
 * non-looping tracks (explicit duration, else file length minus the seek
 * offset) — so back-to-back songs fit to the last one. Null when nothing
 * usable: no tracks, all looping, or any candidate's length still unknown. */
function musicEnd(project: Project, media: MediaItem[]): number | null {
  let end: number | null = null;
  for (const track of project.audio) {
    if (track.loop) continue;
    let len = track.duration;
    if (len === null) {
      const item = media.find((m) => m.path === track.path);
      if (item?.status !== "ready" || item.info.duration <= 0) return null;
      len = item.info.duration - track.offset;
    }
    if (len <= 0) continue;
    end = Math.max(end ?? 0, track.start + len);
  }
  return end;
}

export default function ProjectValues() {
  const project = useEditor((s) => s.project);
  const mutate = useEditor((s) => s.mutate);
  const media = useEditor((s) => s.media);
  const timing = useEditor((s) => s.timing);

  // Scale every slide's time-on-screen so the film ends with the music.
  // Transition and outro spans stay fixed, so the delta lands entirely on
  // the sum of durations — one linear correction, clamped to sane slides.
  const fitTarget = musicEnd(project, media);
  const canFit =
    fitTarget !== null && timing !== null && timing.total > 0 && project.slides.length > 0;
  const fitToMusic = () => {
    if (fitTarget === null || timing === null) return;
    const sum = project.slides.reduce((acc, s) => acc + s.duration, 0);
    const needed = sum + (fitTarget - timing.total);
    if (sum <= 0 || needed <= 0) return;
    const f = needed / sum;
    mutate((p) => ({
      ...p,
      slides: p.slides.map((s) => ({
        ...s,
        duration: Math.min(120, Math.max(1, s.duration * f)),
      })),
    }));
  };

  const patchAudio = (ai: number, patch: Partial<AudioTrack>) =>
    mutate((p) => ({
      ...p,
      audio: p.audio.map((a, i) => (i === ai ? { ...a, ...patch } : a)),
    }));

  return (
    <details className="values">
      <summary>
        Project &amp; Music
        <span className="values-scope">
          · {project.audio.length} track{project.audio.length === 1 ? "" : "s"}
        </span>
      </summary>
      <VGroup label="Music">
        {project.audio.length === 0 && (
          <p className="hint">Add music from the “Not used” shelf (+ Music).</p>
        )}
        {project.audio.map((a, ai) => (
          <div key={ai} className="sub-card">
            <div className="sub-head">
              <span>{a.path.replace(/^.*[/\\]/, "")}</span>
              <button
                title="Remove this track"
                aria-label={`Remove music track ${a.path.replace(/^.*[/\\]/, "")}`}
                onClick={() => mutate((p) => ({ ...p, audio: p.audio.filter((_, i) => i !== ai) }))}
              >
                ✕
              </button>
            </div>
            <NumField label="Start at" value={a.start} min={0} max={9999} step={0.5} display="s"
              onChange={(start) => patchAudio(ai, { start })} />
            <SliderField label="Gain" value={a.gain_db} min={-40} max={12} step={1} display="dB"
              onChange={(gain_db) => patchAudio(ai, { gain_db })} />
            <SliderField label="Fade in" value={a.fade_in} min={0} max={20} step={0.5} display="s"
              onChange={(fade_in) => patchAudio(ai, { fade_in })} />
            <SliderField label="Fade out" value={a.fade_out} min={0} max={20} step={0.5} display="s"
              onChange={(fade_out) => patchAudio(ai, { fade_out })} />
            <Segmented
              label="Loop"
              options={[
                { label: "Off", value: "off" },
                { label: "On", value: "on" },
              ]}
              value={a.loop ? "on" : "off"}
              onChange={(v) => patchAudio(ai, { loop: v === "on" })}
            />
          </div>
        ))}
        {project.audio.length > 0 && (
          <div className="vrow">
            <span className="vlabel">Timing</span>
            <button
              disabled={!canFit}
              title={
                canFit
                  ? `Stretch or squeeze every slide so the film ends with the music (${fitTarget.toFixed(1)}s)`
                  : "Needs a non-looping track with a known length, and at least one slide"
              }
              onClick={fitToMusic}
            >
              Fit to music
            </button>
          </div>
        )}
      </VGroup>
      <VGroup label="Output">
        <NumField label="FPS" value={project.settings.fps} min={10} max={60} step={1}
          onChange={(fps) => mutate((p) => ({ ...p, settings: { ...p.settings, fps } }))} />
        <NumField label="Outro time" value={project.outro.duration} min={0} max={10} step={0.1} display="s"
          onChange={(duration) => mutate((p) => ({ ...p, outro: { ...p.outro, duration } }))} />
        <SliderField label="Text margin" value={project.settings.text_margin} min={0} max={0.15} step={0.005} display="pct"
          onChange={(text_margin) =>
            mutate((p) => ({ ...p, settings: { ...p.settings, text_margin } }))
          } />
        <ColorField label="Background" value={project.settings.background}
          onChange={(background) => mutate((p) => ({ ...p, settings: { ...p.settings, background } }))} />
      </VGroup>
    </details>
  );
}
