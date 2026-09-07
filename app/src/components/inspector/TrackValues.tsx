// One music track's controls: where it sits on the film (start, end), where in
// the file it begins, its fades and gain, and whether it loops to fill the
// film. Overlaps with neighbouring tracks are echoed so a cross-fade is
// something you can read, not just hear.

import { useEditor } from "../../store";
import { trackLength } from "../../marks";
import type { AudioTrack, MediaItem } from "../../types";
import { EchoRow, NumField, Segmented, SliderField, VGroup } from "./fields";

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}.${Math.floor((t % 1) * 10)}`;
const baseName = (path: string) => path.replace(/^.*[/\\]/, "");

function sourceLength(track: AudioTrack, media: MediaItem[]): number | undefined {
  const item = media.find((m) => m.path === track.path);
  return item?.status === "ready" && item.info.duration > 0 ? item.info.duration : undefined;
}

export default function TrackValues({ index }: { index: number }) {
  const project = useEditor((s) => s.project);
  const media = useEditor((s) => s.media);
  const timing = useEditor((s) => s.timing);
  const mutate = useEditor((s) => s.mutate);
  const track = project.audio[index];
  if (!track) return null;

  const total = timing?.total ?? 0;
  const source = sourceLength(track, media);
  const length = trackLength(track, total, source);
  const end = track.start + length;
  const patch = (p: Partial<AudioTrack>) =>
    mutate((pr) => ({ ...pr, audio: pr.audio.map((a, i) => (i === index ? { ...a, ...p } : a)) }));

  // Every other track this one shares time with, in timeline order.
  const overlaps = project.audio
    .map((other, j) => {
      if (j === index) return null;
      const oEnd = other.start + trackLength(other, total, sourceLength(other, media));
      const shared = Math.min(end, oEnd) - Math.max(track.start, other.start);
      return shared > 0.05 ? { name: baseName(other.path), shared, start: other.start } : null;
    })
    .filter((o): o is { name: string; shared: number; start: number } => o !== null)
    .sort((a, b) => a.start - b.start);

  return (
    <>
      <VGroup label="On the film">
        <NumField label="Start at" value={track.start} min={0} max={9999} step={0.5} display="s"
          onChange={(start) => patch({ start: Math.max(0, start) })} />
        <NumField label="End at" value={Math.round(end * 100) / 100} min={0} max={9999} step={0.5} display="s"
          onChange={(v) => patch({ duration: Math.max(0.5, v - track.start) })} />
        <div className="vrow">
          <span className="vlabel">Length</span>
          <button
            disabled={track.duration === null}
            title={track.loop ? "Loop until the film ends" : "Play the file through to its end"}
            onClick={() => patch({ duration: null })}
          >
            {track.loop ? "To film end" : "Whole song"}
          </button>
        </div>
        <EchoRow label="Plays" value={`${fmt(track.start)} – ${fmt(end)}`} />
        {overlaps.map((o) => (
          <EchoRow key={o.name + o.start} label={`Overlaps “${o.name}”`} value={`${o.shared.toFixed(1)}s`} />
        ))}
      </VGroup>
      <VGroup label="In the file">
        <NumField label="Skip intro" value={track.offset} min={0} max={source ?? 9999} step={0.5} display="s"
          onChange={(offset) => patch({ offset: Math.max(0, offset) })} />
        {source !== undefined && <EchoRow label="File length" value={fmt(source)} />}
        <Segmented
          label="Loop"
          options={[
            { label: "Off", value: "off" },
            { label: "On", value: "on" },
          ]}
          value={track.loop ? "on" : "off"}
          onChange={(v) => patch({ loop: v === "on" })}
        />
      </VGroup>
      <VGroup label="Sound">
        <SliderField label="Fade in" value={track.fade_in} min={0} max={20} step={0.5} display="s"
          onChange={(fade_in) => patch({ fade_in })} />
        <SliderField label="Fade out" value={track.fade_out} min={0} max={20} step={0.5} display="s"
          onChange={(fade_out) => patch({ fade_out })} />
        <SliderField label="Gain" value={track.gain_db} min={-40} max={12} step={1} display="dB"
          onChange={(gain_db) => patch({ gain_db })} />
      </VGroup>
    </>
  );
}
