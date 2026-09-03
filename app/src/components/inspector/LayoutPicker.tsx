// Visual layout picker: every tile is a true mini-preview — the real layout
// geometry at the slide's member count, each cell painted with its photo's
// thumbnail in the current photo order (diagram ink until thumbs are ready).

import type { CSSProperties } from "react";
import { layoutRects } from "../../layout";
import { activeLayoutIndex, layoutOptions, scatterState } from "../../layouts";
import { useEditor } from "../../store";
import type { MediaItem, Slide } from "../../types";

/** Tile dimensions matching the project's frame shape at a constant area,
 * so a vertical or square project gets honest mini-diagrams (16:9 keeps the
 * classic 56×32). */
export function layoutTileSize(aspect: number): { w: number; h: number } {
  const AREA = 56 * 32;
  const clamp = (v: number) => Math.round(Math.min(64, Math.max(22, v)));
  return { w: clamp(Math.sqrt(AREA * aspect)), h: clamp(Math.sqrt(AREA / aspect)) };
}

/** CSS background per cell, in cell order: the photo's thumbnail when the
 * bin has it, a solid cell's own color, or null for the diagram-ink
 * fallback. */
export function cellFills(slide: Slide, media: MediaItem[]): (string | null)[] {
  const byPath = new Map(media.map((m) => [m.path, m]));
  return slide.cells.map((c) => {
    if (c.source.type === "solid") return c.source.color;
    const m = byPath.get(c.source.path);
    return m && m.status === "ready" && m.thumb ? `url(${JSON.stringify(m.thumb)})` : null;
  });
}

/** One cell of a tile preview. `fill` is a color, an image url(), or null. */
export function TileCell({
  r,
  fill,
  rotation,
  dashed,
}: {
  r: { x: number; y: number; w: number; h: number };
  fill: string | null;
  rotation?: number;
  dashed?: boolean;
}) {
  const style: CSSProperties = {
    left: r.x,
    top: r.y,
    width: Math.max(r.w, 2),
    height: Math.max(r.h, 2),
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
  };
  if (fill?.startsWith("url(")) {
    style.backgroundImage = fill;
    style.backgroundSize = "cover";
    style.backgroundPosition = "center";
  } else if (fill) {
    style.backgroundColor = fill;
  }
  return <span className={`lt-cell${dashed ? " dashed" : ""}`} style={style} />;
}

export default function LayoutPicker({ slide, index }: { slide: Slide; index: number }) {
  const media = useEditor((s) => s.media);
  const updateSlide = useEditor((s) => s.updateSlide);
  const settings = useEditor((s) => s.project.settings);
  const { w: TILE_W, h: TILE_H } = layoutTileSize(settings.width / Math.max(1, settings.height));
  const fills = cellFills(slide, media);

  const options = layoutOptions(slide, media);
  let active = activeLayoutIndex(options, slide);
  // Any pile — every variant, plain or smart-dealt — lights the one Scatter
  // tile; the variant choice lives in the Pile row below the picker.
  if (active < 0 && scatterState(slide) !== "off") {
    active = options.findIndex((o) => o.key === "scatter");
  }

  return (
    <div className="layout-picker" role="group" aria-label="Layout">
      {options.map((o, i) => {
        const rects = layoutRects(o.layout, slide.cells.length, TILE_W, TILE_H, 0, 0.03);
        return (
          <button
            key={o.key}
            className={`layout-tile ${i === active ? "on" : ""}`}
            style={{ width: TILE_W, height: TILE_H }}
            title={o.label}
            aria-label={o.label}
            aria-pressed={i === active}
            onClick={() => updateSlide(index, o.apply(slide))}
          >
            {rects.map((r, ci) => (
              <TileCell
                key={ci}
                r={r}
                fill={fills[ci] ?? null}
                rotation={o.tileRotations?.[ci % o.tileRotations.length]}
              />
            ))}
          </button>
        );
      })}
      {active < 0 && (
        <span
          className="layout-tile on custom"
          style={{ width: TILE_W, height: TILE_H }}
          title="Hand-edited layout (from the project file)"
        >
          {layoutRects(slide.layout, slide.cells.length, TILE_W, TILE_H, 0, 0.03).map((r, ci) => (
            <TileCell
              key={ci}
              r={r}
              fill={fills[ci] ?? null}
              rotation={slide.cells[ci]?.rotation || undefined}
              dashed
            />
          ))}
        </span>
      )}
    </div>
  );
}
