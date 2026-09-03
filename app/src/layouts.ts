// The layout catalog: everything the picker can offer a slide, built from
// the current member count and the bin's probed aspects. Quilts and scatter
// are preset generators over the engine's custom rects — scatter also owns
// per-cell rotation data, which stays editable cell state so finer user
// control (per-print angle, spread) can land later without a format change.

import { autoLayout } from "./presets";
import type { Border, Cell, Layout, MediaItem, NormRect, Slide, SlideBackground } from "./types";

/** What applying a picker option does to the slide. Layout always; cells and
 * background only when the option owns them (scatter's rotations, frames,
 * and grounding blur). Optional keys are OMITTED when unused — an explicit
 * `undefined` would erase the slide's value in the update spread. */
export interface LayoutPatch {
  layout: Layout;
  cells?: Cell[];
  background?: SlideBackground;
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
export const SCATTER_BORDER: Border = { width: 0.012, color: "#ffffff", lip: 0.035 };

/** Deterministic print piles per count, tuned to the reference grammar:
 * cell 0 is the hero (~1.4× companions, gentlest tilt) and draws first, so
 * companions tuck over its edges without crossing its middle; the cluster
 * owns ~90% of the frame around a slightly off-center gravity. Capped at 6. */
const SCATTER_PILES: Record<number, { rects: NormRect[]; angles: number[] }> = {
  2: {
    rects: [
      { x: 0.08, y: 0.06, w: 0.5, h: 0.82 },
      { x: 0.48, y: 0.22, w: 0.42, h: 0.68 },
    ],
    angles: [-2, 5],
  },
  3: {
    rects: [
      { x: 0.3, y: 0.05, w: 0.44, h: 0.8 },
      { x: 0.04, y: 0.16, w: 0.34, h: 0.62 },
      { x: 0.64, y: 0.24, w: 0.34, h: 0.62 },
    ],
    angles: [2, -7, 6],
  },
  4: {
    rects: [
      { x: 0.28, y: 0.04, w: 0.46, h: 0.74 },
      { x: 0.02, y: 0.1, w: 0.32, h: 0.58 },
      { x: 0.68, y: 0.08, w: 0.31, h: 0.56 },
      { x: 0.36, y: 0.44, w: 0.33, h: 0.55 },
    ],
    angles: [-2, -8, 7, 4],
  },
  5: {
    rects: [
      { x: 0.3, y: 0.1, w: 0.42, h: 0.68 },
      { x: 0.02, y: 0.04, w: 0.3, h: 0.52 },
      { x: 0.7, y: 0.05, w: 0.29, h: 0.5 },
      { x: 0.05, y: 0.45, w: 0.3, h: 0.52 },
      { x: 0.67, y: 0.44, w: 0.3, h: 0.53 },
    ],
    angles: [2, -7, 8, -4, 5],
  },
  6: {
    rects: [
      { x: 0.3, y: 0.08, w: 0.4, h: 0.64 },
      { x: 0.02, y: 0.03, w: 0.28, h: 0.5 },
      { x: 0.72, y: 0.04, w: 0.27, h: 0.48 },
      { x: 0.02, y: 0.46, w: 0.28, h: 0.51 },
      { x: 0.7, y: 0.45, w: 0.29, h: 0.52 },
      { x: 0.37, y: 0.5, w: 0.3, h: 0.48 },
    ],
    angles: [-2, -8, 7, -5, 6, 3],
  },
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
  return a !== null && a.width === b.width && a.color === b.color && a.lip === b.lip;
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
    const pile = SCATTER_PILES[n];
    if (pile) {
      const layout: Layout = { type: "custom", rects: pile.rects };
      out.push({
        key: "scatter",
        label: "Scatter",
        layout,
        tileRotations: pile.angles,
        apply: (s) => {
          const patch: LayoutPatch = {
            layout,
            cells: s.cells.map((c, i) => ({
              ...c,
              rotation: pile.angles[i % pile.angles.length],
              border: c.border ?? { ...SCATTER_BORDER },
            })),
          };
          // The pile sits on a surface, not a void: ground it on the hero's
          // own blur unless the user already chose a background.
          if (s.background.type === "default") {
            patch.background = { type: "blur", cell: 0, sigma: 0.02, dim: 0.35 };
          }
          return patch;
        },
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

// ---- smart scatter: the pile optimizes around the faces ----
//
// The layout-level counterpart of per-photo fit: whatever fit each photo
// chose, its stored face box (smart_focus, captured at import for every
// photo) projects through that fit's crop math into frame space, and a
// deterministic search assigns prints to slots so later-drawn prints cover
// as little face as possible — big faces earn the hero slot. Cell order (and
// with it stacking) never changes; only which slot each print occupies.

interface FrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxArea(b: FrameBox): number {
  return Math.max(b.w, 0) * Math.max(b.h, 0);
}

function intersectArea(a: FrameBox, b: FrameBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Where a cell's face lands in frame space when its photo renders into
 * `rect` under the cell's own fit mode. Mirrors the compositor's crop math
 * (rotation ignored — angles are small and this is a ranking, not pixels). */
function faceInFrame(rect: FrameBox, aspect: number, cell: Cell): FrameBox | null {
  const face = cell.smart_focus;
  if (!face) return null;
  const sw = aspect;
  const sh = 1;
  let s: number;
  let cropX = 0;
  let cropY = 0;
  let destX = rect.x;
  let destY = rect.y;
  if (cell.fit === "contain") {
    s = Math.min(rect.w / sw, rect.h / sh);
    destX = rect.x + (rect.w - sw * s) / 2;
    destY = rect.y + (rect.h - sh * s) / 2;
  } else {
    s = Math.max(rect.w / sw, rect.h / sh);
    const vw = rect.w / s;
    const vh = rect.h / s;
    if (cell.fit === "smart") {
      const fx = (face.x + face.w / 2) * sw;
      const fy = (face.y + face.h / 2) * sh;
      cropX = Math.min(Math.max(fx - vw / 2, 0), Math.max(sw - vw, 0));
      cropY = Math.min(Math.max(fy - vh / 2, 0), Math.max(sh - vh, 0));
    } else {
      cropX = (sw - vw) / 2;
      cropY = (sh - vh) / 2;
    }
  }
  const raw: FrameBox = {
    x: destX + (face.x * sw - cropX) * s,
    y: destY + (face.y * sh - cropY) * s,
    w: face.w * sw * s,
    h: face.h * sh * s,
  };
  // Only the part inside the print is visible at all.
  const clipped: FrameBox = {
    x: Math.max(raw.x, rect.x),
    y: Math.max(raw.y, rect.y),
    w: Math.min(raw.x + raw.w, rect.x + rect.w) - Math.max(raw.x, rect.x),
    h: Math.min(raw.y + raw.h, rect.y + rect.h) - Math.max(raw.y, rect.y),
  };
  return clipped.w > 0 && clipped.h > 0 ? clipped : null;
}

function permutations(n: number): number[][] {
  if (n === 1) return [[0]];
  const out: number[][] = [];
  for (const rest of permutations(n - 1)) {
    for (let i = 0; i <= rest.length; i++) {
      out.push([...rest.slice(0, i), n - 1, ...rest.slice(i)]);
    }
  }
  return out;
}

/** Scatter with the pile arranged around the faces: cell i takes slot
 * `assignment[i]`, chosen to minimize face area hidden under later-drawn
 * prints, with a pull toward big faces on big slots. Deterministic: ties go
 * to the arrangement closest to the plain table order. */
export function smartScatterPatch(slide: Slide, media: MediaItem[]): LayoutPatch | null {
  const n = slide.cells.length;
  const pile = SCATTER_PILES[n];
  if (!pile) return null;
  const aspects = cellAspects(slide, media);

  const score = (assignment: number[]): number => {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const rect = pile.rects[assignment[i]];
      const face = faceInFrame(rect, aspects[i], slide.cells[i]);
      if (!face) continue;
      const area = boxArea(face);
      // Later cells draw on top; sum what they cover of this face.
      let covered = 0;
      for (let j = i + 1; j < n; j++) {
        covered += intersectArea(face, pile.rects[assignment[j]]);
      }
      cost += Math.min(covered, area);
      // Big faces earn big slots (the hero most of all).
      cost -= 0.3 * area * boxArea(rect);
    }
    return cost;
  };

  let best = assignmentsFor(n)[0];
  let bestScore = Infinity;
  for (const p of assignmentsFor(n)) {
    const s = score(p);
    if (s < bestScore - 1e-9) {
      bestScore = s;
      best = p;
    }
  }

  return {
    layout: { type: "custom", rects: slide.cells.map((_, i) => pile.rects[best[i]]) },
    cells: slide.cells.map((c, i) => ({
      ...c,
      rotation: pile.angles[best[i]],
      border: c.border ?? { ...SCATTER_BORDER },
    })),
    ...(slide.background.type === "default"
      ? { background: { type: "blur", cell: 0, sigma: 0.02, dim: 0.35 } as SlideBackground }
      : {}),
  };
}

/** All slot assignments in a stable order (identity first, so ties keep the
 * plain arrangement). */
function assignmentsFor(n: number): number[][] {
  const all = permutations(n);
  all.sort((a, b) => {
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  });
  return all;
}

/** Whether the slide is on scatter at all, and which flavor: the plain table
 * order, a smart (permuted) pile, or not scatter. */
export function scatterState(slide: Slide): "off" | "plain" | "smart" {
  const pile = SCATTER_PILES[slide.cells.length];
  if (!pile || slide.layout.type !== "custom") return "off";
  const current = slide.layout.rects;
  if (current.length !== pile.rects.length) return "off";
  if (JSON.stringify(current) === JSON.stringify(pile.rects)) return "plain";
  // A permutation of the pile's slots = the smart arrangement.
  const key = (r: NormRect) => JSON.stringify(r);
  const slots = new Set(pile.rects.map(key));
  const used = new Set(current.map(key));
  if (slots.size === used.size && [...used].every((k) => slots.has(k))) return "smart";
  return "off";
}
