import { useState } from "react";
import { importPaths } from "../App";
import { cellFor, defaultSlide, slideForMedia } from "../presets";
import { useEditor } from "../store";
import type { Layout, Slide } from "../types";

function layoutGlyph(layout: Layout): string {
  switch (layout.type) {
    case "single":
      return "▣";
    case "rows":
      return "▤";
    case "columns":
      return "▥";
    case "grid":
      return "▦";
    case "featured":
      return "◧";
    case "custom":
      return "◫";
  }
}

function transitionGlyph(s: Slide): string {
  switch (s.transition.kind.type) {
    case "cut":
      return "∎";
    case "cross_fade":
      return "⤬";
    case "fade_black":
    case "fade_white":
      return "◐";
    case "slide":
      return "⇢";
    case "wipe":
      return "⧉";
  }
}

export default function Filmstrip() {
  const project = useEditor((s) => s.project);
  const selected = useEditor((s) => s.selectedSlide);
  const selectSlide = useEditor((s) => s.selectSlide);
  const mutate = useEditor((s) => s.mutate);
  const media = useEditor((s) => s.media);
  const addMediaToBin = useEditor((s) => s.addMedia);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const addEmpty = () =>
    mutate((p) => ({ ...p, slides: [...p.slides, defaultSlide()] }));

  const duplicate = (i: number) =>
    mutate((p) => {
      const copy: Slide = JSON.parse(JSON.stringify(p.slides[i]));
      copy.id = `${copy.id}-copy`;
      const slides = [...p.slides];
      slides.splice(i + 1, 0, copy);
      return { ...p, slides };
    });

  const remove = (i: number) =>
    mutate((p) => ({ ...p, slides: p.slides.filter((_, j) => j !== i) }));

  const move = (from: number, to: number) =>
    mutate((p) => {
      if (to < 0 || to >= p.slides.length || from === to) return p;
      const slides = [...p.slides];
      const [s] = slides.splice(from, 1);
      slides.splice(to, 0, s);
      return { ...p, slides };
    });

  /** Drop a media-bin item (or an OS file) onto a slide → add as cell; onto the strip → new slide. */
  const handleDrop = async (e: React.DragEvent, slideIndex: number | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const path = e.dataTransfer.getData("application/x-media-path");
    const reorder = e.dataTransfer.getData("application/x-slide-index");
    if (reorder && slideIndex !== null) {
      move(parseInt(reorder, 10), slideIndex);
      return;
    }
    if (!path) return;
    let item = media.find((m) => m.path === path);
    if (!item) {
      const items = await importPaths([path]);
      if (!items.length) return;
      addMediaToBin(items);
      item = items[0];
    }
    if (item.info.has_audio && !item.info.has_video && !item.info.is_image) return;
    if (slideIndex === null) {
      const slide = slideForMedia(item);
      mutate((p) => ({ ...p, slides: [...p.slides, slide] }));
    } else {
      mutate((p) => ({
        ...p,
        slides: p.slides.map((s, i) =>
          i === slideIndex ? { ...s, cells: [...s.cells, cellFor(item!, s.cells.length)] } : s,
        ),
      }));
    }
  };

  return (
    <footer
      className="filmstrip"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => handleDrop(e, null)}
    >
      {project.slides.map((s, i) => (
        <div
          key={s.id + i}
          className={`slide-chip ${i === selected ? "selected" : ""} ${dragOver === i ? "drag-over" : ""}`}
          onClick={() => selectSlide(i)}
          draggable
          onDragStart={(e) => e.dataTransfer.setData("application/x-slide-index", String(i))}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(i);
          }}
          onDragLeave={() => setDragOver((d) => (d === i ? null : d))}
          onDrop={(e) => handleDrop(e, i)}
        >
          <div className="chip-row">
            <span className="chip-glyph">{layoutGlyph(s.layout)}</span>
            <span className="chip-index">{i + 1}</span>
            <span className="chip-trans" title="Transition in">
              {i > 0 ? transitionGlyph(s) : ""}
            </span>
          </div>
          <div className="chip-title">{s.id || `slide ${i + 1}`}</div>
          <div className="chip-row chip-info">
            <span>{s.duration.toFixed(1)}s</span>
            <span>{s.cells.length ? `${s.cells.length}▦` : "—"}</span>
            <span>{s.texts.length ? `${s.texts.length}T` : ""}</span>
          </div>
          <div className="chip-actions">
            <button title="Move left" onClick={(e) => (e.stopPropagation(), move(i, i - 1))}>
              ←
            </button>
            <button title="Duplicate" onClick={(e) => (e.stopPropagation(), duplicate(i))}>
              ⧉
            </button>
            <button title="Delete" onClick={(e) => (e.stopPropagation(), remove(i))}>
              ✕
            </button>
            <button title="Move right" onClick={(e) => (e.stopPropagation(), move(i, i + 1))}>
              →
            </button>
          </div>
        </div>
      ))}
      <button className="add-slide" onClick={addEmpty} title="Add empty slide">
        +
      </button>
    </footer>
  );
}
