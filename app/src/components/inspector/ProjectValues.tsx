// Project & Music: the raw fields no selection can reach. Always present,
// collapsed by default — it survives empty projects and empty selections.

import { useEditor } from "../../store";
import type { AudioTrack } from "../../types";
import { ColorField, NumField, Segmented, SliderField, VGroup } from "./fields";

export default function ProjectValues() {
  const project = useEditor((s) => s.project);
  const mutate = useEditor((s) => s.mutate);

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
      </VGroup>
      <VGroup label="Output">
        <NumField label="FPS" value={project.settings.fps} min={10} max={60} step={1}
          onChange={(fps) => mutate((p) => ({ ...p, settings: { ...p.settings, fps } }))} />
        <NumField label="Outro time" value={project.outro.duration} min={0} max={10} step={0.1} display="s"
          onChange={(duration) => mutate((p) => ({ ...p, outro: { ...p.outro, duration } }))} />
        <ColorField label="Background" value={project.settings.background}
          onChange={(background) => mutate((p) => ({ ...p, settings: { ...p.settings, background } }))} />
      </VGroup>
    </details>
  );
}
