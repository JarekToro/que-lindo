// Visual layout picker: a grid of mini-diagrams drawn live from layoutRects,
// so every tile shows the true shape at the slide's current member count.

import { layoutRects } from "../../layout";
import { activeLayoutIndex, layoutOptions, scatterState } from "../../layouts";
import { useEditor } from "../../store";
import type { Slide } from "../../types";

const TILE_W = 56;
const TILE_H = 32;

export default function LayoutPicker({ slide, index }: { slide: Slide; index: number }) {
  const media = useEditor((s) => s.media);
  const updateSlide = useEditor((s) => s.updateSlide);

  const options = layoutOptions(slide, media);
  let active = activeLayoutIndex(options, slide);
  // A smart-dealt pile is still scatter: light the variant whose slots the
  // deal permutes, not the "custom" tile.
  if (active < 0 && scatterState(slide) === "smart" && slide.layout.type === "custom") {
    const used = new Set(slide.layout.rects.map((r) => JSON.stringify(r)));
    active = options.findIndex((o) => {
      if (!o.key.startsWith("scatter") || o.layout.type !== "custom") return false;
      const slots = new Set(o.layout.rects.map((r) => JSON.stringify(r)));
      return slots.size === used.size && [...used].every((k) => slots.has(k));
    });
  }

  return (
    <div className="layout-picker" role="group" aria-label="Layout">
      {options.map((o, i) => {
        const rects = layoutRects(o.layout, slide.cells.length, TILE_W, TILE_H, 0, 0.03);
        return (
          <button
            key={o.key}
            className={`layout-tile ${i === active ? "on" : ""}`}
            title={o.label}
            aria-label={o.label}
            aria-pressed={i === active}
            onClick={() => updateSlide(index, o.apply(slide))}
          >
            {rects.map((r, ci) => (
              <span
                key={ci}
                className="lt-cell"
                style={{
                  left: r.x,
                  top: r.y,
                  width: Math.max(r.w, 2),
                  height: Math.max(r.h, 2),
                  transform: o.tileRotations ? `rotate(${o.tileRotations[ci % o.tileRotations.length]}deg)` : undefined,
                }}
              />
            ))}
          </button>
        );
      })}
      {active < 0 && (
        <span className="layout-tile on custom" title="Hand-edited layout (from the project file)">
          {layoutRects(slide.layout, slide.cells.length, TILE_W, TILE_H, 0, 0.03).map((r, ci) => (
            <span
              key={ci}
              className="lt-cell dashed"
              style={{
                left: r.x,
                top: r.y,
                width: Math.max(r.w, 2),
                height: Math.max(r.h, 2),
                transform: slide.cells[ci]?.rotation
                  ? `rotate(${slide.cells[ci].rotation}deg)`
                  : undefined,
              }}
            />
          ))}
        </span>
      )}
    </div>
  );
}
