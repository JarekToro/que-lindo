// The layout catalog: everything the picker can offer a slide, built from
// the current member count and the bin's probed aspects. Quilts and scatter
// are preset generators over the engine's custom rects — scatter also owns
// per-cell rotation data, which stays editable cell state so finer user
// control (per-print angle, spread) can land later without a format change.

import { autoLayout } from "./presets";
import type { Border, Cell, Layout, MediaItem, NormRect, Slide } from "./types";

/** What applying a picker option does to the slide. Layout always; cells
 * only when the option owns cell data (scatter's rotations and frames). */
export interface LayoutPatch {
  layout: Layout;
  cells?: Cell[];
}

export interface LayoutOption {
  key: string;
  label: string;
  /** Tile preview and application both flow from the same layout value. */
  layout: Layout;
  /** Per-cell rotation the tile preview shows (scatter only). */
  tileRotations?: number[];
  apply: (slide: Slide) => LayoutPatch;
}

/** The white print frame scatter puts on frameless photos. */
export const SCATTER_BORDER: Border = { width: 0.008, color: "#ffffff" };

const scatterAngles = [-6, 4, -3, 5, -5, 3, -4, 2];

/** Deterministic polaroid piles per count: normalized print rects along a
 * loose arc, angles alternating by index. Capped at 6 prints. */
const SCATTER_RECTS: Record<number, NormRect[]> = {
  2: [
    { x: 0.1, y: 0.12, w: 0.42, h: 0.72 },
    { x: 0.46, y: 0.18, w: 0.42, h: 0.72 },
  ],
  3: [
    { x: 0.04, y: 0.16, w: 0.34, h: 0.62 },
    { x: 0.33, y: 0.08, w: 0.36, h: 0.68 },
    { x: 0.64, y: 0.2, w: 0.34, h: 0.62 },
  ],
  4: [
    { x: 0.03, y: 0.06, w: 0.3, h: 0.56 },
    { x: 0.28, y: 0.16, w: 0.32, h: 0.6 },
    { x: 0.55, y: 0.05, w: 0.3, h: 0.56 },
    { x: 0.32, y: 0.44, w: 0.32, h: 0.55 },
  ],
  5: [
    { x: 0.02, y: 0.08, w: 0.27, h: 0.52 },
    { x: 0.24, y: 0.02, w: 0.28, h: 0.54 },
    { x: 0.48, y: 0.1, w: 0.27, h: 0.52 },
    { x: 0.13, y: 0.44, w: 0.28, h: 0.54 },
    { x: 0.62, y: 0.42, w: 0.28, h: 0.54 },
  ],
  6: [
    { x: 0.02, y: 0.05, w: 0.26, h: 0.5 },
    { x: 0.24, y: 0.0, w: 0.27, h: 0.52 },
    { x: 0.47, y: 0.06, w: 0.26, h: 0.5 },
    { x: 0.7, y: 0.02, w: 0.27, h: 0.52 },
    { x: 0.16, y: 0.45, w: 0.27, h: 0.52 },
    { x: 0.55, y: 0.46, w: 0.27, h: 0.52 },
  ],
};

/** Hand-designed photo-book patterns per count (gap baked at 2%). */
const QUILTS: Record<number, { key: string; label: string; rects: NormRect[] }[]> = {
  2: [
    {
      key: "inset",
      label: "Inset",
      rects: [
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 0.6, y: 0.58, w: 0.37, h: 0.39 },
      ],
    },
  ],
  3: [
    {
      key: "tower",
      label: "Tower",
      rects: [
        { x: 0.51, y: 0, w: 0.49, h: 1 },
        { x: 0, y: 0, w: 0.49, h: 0.49 },
        { x: 0, y: 0.51, w: 0.49, h: 0.49 },
      ],
    },
    {
      key: "band",
      label: "Band",
      rects: [
        { x: 0.34, y: 0, w: 0.32, h: 1 },
        { x: 0, y: 0.19, w: 0.32, h: 0.62 },
        { x: 0.68, y: 0.19, w: 0.32, h: 0.62 },
      ],
    },
  ],
  4: [
    {
      key: "pinwheel",
      label: "Pinwheel",
      rects: [
        { x: 0, y: 0, w: 0.61, h: 0.49 },
        { x: 0.63, y: 0, w: 0.37, h: 0.49 },
        { x: 0, y: 0.51, w: 0.37, h: 0.49 },
        { x: 0.39, y: 0.51, w: 0.61, h: 0.49 },
      ],
    },
    {
      key: "hero-row",
      label: "Hero row",
      rects: [
        { x: 0, y: 0, w: 1, h: 0.64 },
        { x: 0, y: 0.68, w: 0.32, h: 0.32 },
        { x: 0.34, y: 0.68, w: 0.32, h: 0.32 },
        { x: 0.68, y: 0.68, w: 0.32, h: 0.32 },
      ],
    },
  ],
  5: [
    {
      key: "quilt",
      label: "Quilt",
      rects: [
        { x: 0, y: 0, w: 0.49, h: 1 },
        { x: 0.51, y: 0, w: 0.235, h: 0.49 },
        { x: 0.765, y: 0, w: 0.235, h: 0.49 },
        { x: 0.51, y: 0.51, w: 0.235, h: 0.49 },
        { x: 0.765, y: 0.51, w: 0.235, h: 0.49 },
      ],
    },
  ],
  6: [
    {
      key: "hero-quilt",
      label: "Hero quilt",
      rects: [
        { x: 0, y: 0, w: 0.66, h: 0.66 },
        { x: 0.68, y: 0, w: 0.32, h: 0.32 },
        { x: 0.68, y: 0.34, w: 0.32, h: 0.32 },
        { x: 0, y: 0.68, w: 0.32, h: 0.32 },
        { x: 0.34, y: 0.68, w: 0.32, h: 0.32 },
        { x: 0.68, y: 0.68, w: 0.32, h: 0.32 },
      ],
    },
  ],
};

function bordersEqual(a: Border | null, b: Border): boolean {
  return a !== null && a.width === b.width && a.color === b.color;
}

/** Plain layout swap: scatter's rotations flatten and its print frames come
 * off (frames the user set themselves stay). */
function applyPlain(layout: Layout): (slide: Slide) => LayoutPatch {
  return (slide) => {
    // Never emit `cells: undefined` — a spread would erase the array.
    const patch: LayoutPatch = { layout };
    if (slide.cells.some((c) => c.rotation !== 0 || bordersEqual(c.border, SCATTER_BORDER))) {
      patch.cells = slide.cells.map((c) => ({
        ...c,
        rotation: 0,
        border: bordersEqual(c.border, SCATTER_BORDER) ? null : c.border,
      }));
    }
    return patch;
  };
}

/** Media aspect (w/h) per cell from the bin, 3:2 when unknown. */
export function cellAspects(slide: Slide, media: MediaItem[]): number[] {
  const byPath = new Map(media.map((m) => [m.path, m]));
  return slide.cells.map((c) => {
    if (c.source.type === "solid") return 1.5;
    const m = byPath.get(c.source.path);
    if (m?.status !== "ready" || m.info.height <= 0) return 1.5;
    return m.info.width / m.info.height;
  });
}

/** Every layout the picker offers for this slide, in display order. */
export function layoutOptions(slide: Slide, media: MediaItem[]): LayoutOption[] {
  const n = slide.cells.length;
  const out: LayoutOption[] = [];
  const plain = (key: string, label: string, layout: Layout) =>
    out.push({ key, label, layout, apply: applyPlain(layout) });

  plain("auto", "Auto", autoLayout(n));
  if (n > 1) {
    plain("columns", "Columns", { type: "columns", weights: [] });
    plain("rows", "Rows", { type: "rows", weights: [] });
    plain("grid-2", "Grid 2×2", { type: "grid", rows: 2, cols: 2 });
    if (n >= 5) plain("grid-3", "Grid 3×3", { type: "grid", rows: 3, cols: 3 });
    plain("featured-l", "Featured left", { type: "featured", side: "left", ratio: 0.62 });
    plain("featured-r", "Featured right", { type: "featured", side: "right", ratio: 0.62 });
    if (n >= 3) plain("spotlight", "Spotlight", { type: "spotlight", ratio: 0.5 });
    plain("mosaic", "Mosaic", { type: "mosaic", aspects: cellAspects(slide, media) });
    for (const q of QUILTS[n] ?? []) {
      plain(`quilt-${q.key}`, q.label, { type: "custom", rects: q.rects });
    }
    const scatter = SCATTER_RECTS[n];
    if (scatter) {
      const layout: Layout = { type: "custom", rects: scatter };
      out.push({
        key: "scatter",
        label: "Scatter",
        layout,
        tileRotations: scatterAngles,
        apply: (s) => ({
          layout,
          cells: s.cells.map((c, i) => ({
            ...c,
            rotation: scatterAngles[i % scatterAngles.length],
            border: c.border ?? { ...SCATTER_BORDER },
          })),
        }),
      });
    }
  }
  return out;
}

/** The option whose layout the slide currently uses; -1 = hand-edited. */
export function activeLayoutIndex(options: LayoutOption[], slide: Slide): number {
  const current = JSON.stringify(slide.layout);
  return options.findIndex((o) => JSON.stringify(o.layout) === current);
}
