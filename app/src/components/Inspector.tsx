// The inspector: a pinned member strip on top (the navigator), then every
// control for the current selection laid flat beneath it. The slide chip is
// the way back; nothing about the selection hides behind a disclosure.

import { useEffect, useMemo, useState } from "react";
import { listFonts } from "../api";
import { useEditor } from "../store";
import type { Cell, MediaItem, Slide } from "../types";
import ProjectValues from "./inspector/ProjectValues";
import TrackValues from "./inspector/TrackValues";
import { CellValues, MemberStrip, SlideValues, TextValues } from "./inspector/ValuesPane";

export default function Inspector() {
  const project = useEditor((s) => s.project);
  const index = useEditor((s) => s.selectedSlide);
  const selectedCell = useEditor((s) => s.selectedCell);
  const selectedText = useEditor((s) => s.selectedText);
  const selectedIds = useEditor((s) => s.selectedIds);
  const selectedTrack = useEditor((s) => s.selectedTrack);
  const selectTrack = useEditor((s) => s.selectTrack);
  const mutate = useEditor((s) => s.mutate);
  const media = useEditor((s) => s.media);
  const playSlide = useEditor((s) => s.playSlide);
  const [fonts, setFonts] = useState<string[]>([]);

  useEffect(() => {
    listFonts().then(setFonts).catch(() => setFonts([]));
  }, []);

  const thumbs = useMemo(() => new Map(media.map((m) => [m.path, m])), [media]);
  const thumbFor = (c: Cell): string | null => {
    if (c.source.type === "solid") return null;
    const m: MediaItem | undefined = thumbs.get(c.source.path);
    return m && m.status === "ready" ? m.thumb : null;
  };

  const slide: Slide | undefined = project.slides[index];

  // A music track picked in the lane takes the scope over from the slide.
  const track = selectedTrack !== null ? project.audio[selectedTrack] : undefined;
  if (track && selectedTrack !== null) {
    const name = track.path.replace(/^.*[/\\]/, "");
    return (
      <aside className="inspector" aria-label="Inspector">
        <div className="scope">
          <div className="scope-head">
            <span>
              Music · {name}
              <span className="values-scope"> · track {selectedTrack + 1} of {project.audio.length}</span>
            </span>
            <button
              className="ghost"
              title="Remove this track from the film"
              aria-label={`Remove music track ${name}`}
              onClick={() => {
                selectTrack(null);
                mutate((p) => ({ ...p, audio: p.audio.filter((_, i) => i !== selectedTrack) }));
              }}
            >
              Remove
            </button>
          </div>
          <TrackValues index={selectedTrack} />
        </div>
        <ProjectValues />
      </aside>
    );
  }

  if (!slide) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <p className="hint">No slide selected</p>
        <ProjectValues />
      </aside>
    );
  }

  const focusText = selectedText !== null ? slide.texts[selectedText] : undefined;
  const focusCell = selectedCell !== null ? slide.cells[selectedCell] : undefined;
  const isGroup = slide.cells.length > 1;

  const title = focusText
    ? `Text on slide ${index + 1}`
    : focusCell
      ? `Photo ${selectedCell! + 1} of ${slide.cells.length}`
      : isGroup
        ? `Slide ${index + 1} · group of ${slide.cells.length}`
        : `Slide ${index + 1}`;
  const anchorNote =
    !focusText && !focusCell && selectedIds.length > 1
      ? `editing anchor (${selectedIds.length} selected)`
      : null;

  return (
    <aside className="inspector" aria-label="Inspector">
      <MemberStrip slide={slide} index={index} thumbFor={thumbFor} />
      <div className="scope">
        <div className="scope-head">
          <span>
            {title}
            {anchorNote && <span className="values-scope"> · {anchorNote}</span>}
          </span>
          <button
            className="ghost"
            title="Play just this slide, from its start"
            aria-label={`Play slide ${index + 1} from its start`}
            onClick={() => playSlide(index)}
          >
            ▶ Slide
          </button>
        </div>
        {focusText && selectedText !== null ? (
          <TextValues slide={slide} index={index} ti={selectedText} fonts={fonts} />
        ) : focusCell && selectedCell !== null ? (
          <CellValues slide={slide} index={index} ci={selectedCell} />
        ) : (
          <>
            <SlideValues slide={slide} index={index} />
            {slide.cells.length === 1 && <CellValues slide={slide} index={index} ci={0} />}
          </>
        )}
      </div>
      <ProjectValues />
    </aside>
  );
}
