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

interface Pile {
  rects: NormRect[];
  angles: number[];
}

/** Deterministic print piles per count, a few compositions each, tuned to
 * the reference grammar: slot 0 is the hero (larger, gentlest tilt), the
 * cluster owns ~90% of the frame, companions graze edges rather than
 * middles. Smart dealing searches every variant. Counts 2–7. */
const SCATTER_PILES: Record<number, Pile[]> = {
  2: [
    {
      rects: [
        { x: 0.08, y: 0.06, w: 0.5, h: 0.82 },
        { x: 0.48, y: 0.22, w: 0.42, h: 0.68 },
      ],
      angles: [-2, 5],
    },
    {
      rects: [
        { x: 0.16, y: 0.04, w: 0.52, h: 0.78 },
        { x: 0.4, y: 0.3, w: 0.44, h: 0.66 },
      ],
      angles: [3, -6],
    },
  ],
  3: [
    {
      rects: [
        { x: 0.3, y: 0.05, w: 0.44, h: 0.8 },
        { x: 0.04, y: 0.16, w: 0.34, h: 0.62 },
        { x: 0.64, y: 0.24, w: 0.34, h: 0.62 },
      ],
      angles: [2, -7, 6],
    },
    {
      rects: [
        { x: 0.02, y: 0.04, w: 0.42, h: 0.72 },
        { x: 0.3, y: 0.2, w: 0.4, h: 0.68 },
        { x: 0.58, y: 0.34, w: 0.4, h: 0.64 },
      ],
      angles: [-5, 3, 7],
    },
    {
      rects: [
        { x: 0.04, y: 0.06, w: 0.48, h: 0.84 },
        { x: 0.54, y: 0.02, w: 0.4, h: 0.5 },
        { x: 0.56, y: 0.48, w: 0.4, h: 0.5 },
      ],
      angles: [-2, 6, -5],
    },
  ],
  4: [
    {
      rects: [
        { x: 0.28, y: 0.04, w: 0.46, h: 0.74 },
        { x: 0.02, y: 0.1, w: 0.32, h: 0.58 },
        { x: 0.68, y: 0.08, w: 0.31, h: 0.56 },
        { x: 0.36, y: 0.44, w: 0.33, h: 0.55 },
      ],
      angles: [-2, -8, 7, 4],
    },
    {
      rects: [
        { x: 0.0, y: 0.12, w: 0.28, h: 0.6 },
        { x: 0.24, y: 0.02, w: 0.28, h: 0.62 },
        { x: 0.48, y: 0.14, w: 0.28, h: 0.6 },
        { x: 0.72, y: 0.04, w: 0.28, h: 0.62 },
      ],
      angles: [-6, 4, -5, 6],
    },
    {
      rects: [
        { x: 0.06, y: 0.02, w: 0.42, h: 0.52 },
        { x: 0.52, y: 0.06, w: 0.42, h: 0.5 },
        { x: 0.1, y: 0.46, w: 0.4, h: 0.52 },
        { x: 0.5, y: 0.44, w: 0.44, h: 0.54 },
      ],
      angles: [-4, 5, 4, -6],
    },
  ],
  5: [
    {
      rects: [
        { x: 0.3, y: 0.1, w: 0.42, h: 0.68 },
        { x: 0.02, y: 0.04, w: 0.3, h: 0.52 },
        { x: 0.7, y: 0.05, w: 0.29, h: 0.5 },
        { x: 0.05, y: 0.45, w: 0.3, h: 0.52 },
        { x: 0.67, y: 0.44, w: 0.3, h: 0.53 },
      ],
      angles: [2, -7, 8, -4, 5],
    },
    {
      rects: [
        { x: 0.02, y: 0.08, w: 0.44, h: 0.76 },
        { x: 0.48, y: 0.0, w: 0.28, h: 0.48 },
        { x: 0.72, y: 0.12, w: 0.27, h: 0.46 },
        { x: 0.5, y: 0.5, w: 0.28, h: 0.48 },
        { x: 0.73, y: 0.55, w: 0.26, h: 0.44 },
      ],
      angles: [-2, 6, -7, 5, -4],
    },
    {
      rects: [
        { x: 0.32, y: 0.22, w: 0.38, h: 0.6 },
        { x: 0.02, y: 0.02, w: 0.3, h: 0.5 },
        { x: 0.68, y: 0.02, w: 0.3, h: 0.5 },
        { x: 0.03, y: 0.5, w: 0.3, h: 0.5 },
        { x: 0.68, y: 0.5, w: 0.3, h: 0.48 },
      ],
      angles: [2, -8, 7, -6, 5],
    },
  ],
  6: [
    {
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
    {
      rects: [
        { x: 0.01, y: 0.03, w: 0.31, h: 0.5 },
        { x: 0.32, y: 0.0, w: 0.32, h: 0.52 },
        { x: 0.66, y: 0.04, w: 0.31, h: 0.48 },
        { x: 0.03, y: 0.48, w: 0.31, h: 0.5 },
        { x: 0.35, y: 0.5, w: 0.32, h: 0.5 },
        { x: 0.68, y: 0.47, w: 0.3, h: 0.5 },
      ],
      angles: [-6, 3, -5, 5, -3, 7],
    },
    {
      rects: [
        { x: 0.34, y: 0.2, w: 0.34, h: 0.56 },
        { x: 0.04, y: 0.02, w: 0.28, h: 0.46 },
        { x: 0.4, y: 0.0, w: 0.28, h: 0.44 },
        { x: 0.72, y: 0.03, w: 0.27, h: 0.46 },
        { x: 0.08, y: 0.52, w: 0.28, h: 0.46 },
        { x: 0.66, y: 0.52, w: 0.28, h: 0.46 },
      ],
      angles: [2, -7, 5, 7, -5, 4],
    },
  ],
  7: [
    {
      rects: [
        { x: 0.34, y: 0.2, w: 0.34, h: 0.56 },
        { x: 0.02, y: 0.02, w: 0.26, h: 0.44 },
        { x: 0.37, y: 0.0, w: 0.26, h: 0.42 },
        { x: 0.72, y: 0.02, w: 0.26, h: 0.44 },
        { x: 0.02, y: 0.52, w: 0.26, h: 0.46 },
        { x: 0.37, y: 0.6, w: 0.26, h: 0.4 },
        { x: 0.72, y: 0.52, w: 0.26, h: 0.46 },
      ],
      angles: [-2, -7, 4, 6, -5, 3, 5],
    },
    {
      rects: [
        { x: 0.33, y: 0.0, w: 0.34, h: 0.5 },
        { x: 0.0, y: 0.02, w: 0.32, h: 0.48 },
        { x: 0.68, y: 0.03, w: 0.31, h: 0.46 },
        { x: 0.0, y: 0.5, w: 0.25, h: 0.48 },
        { x: 0.25, y: 0.52, w: 0.25, h: 0.46 },
        { x: 0.5, y: 0.5, w: 0.25, h: 0.48 },
        { x: 0.75, y: 0.52, w: 0.24, h: 0.46 },
      ],
      angles: [3, -5, -6, 4, -3, 6, -4],
    },
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
    const piles = SCATTER_PILES[n] ?? [];
    if (piles.length > 0) {
      out.push({
        key: "scatter",
        label: "Scatter",
        layout: { type: "custom", rects: piles[0].rects },
        tileRotations: piles[0].angles,
        // Entering scatter starts in Smart: the scorer picks the variant and
        // the deal (which degrades to the plain first pile when no face is
        // known, since every assignment then scores the same).
        apply: (s) => smartScatterPatch(s, media) ?? scatterPatch(s, piles[0], (i) => i),
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

/** A scatter patch for one pile with cell i taking slot `slot(i)`. */
function scatterPatch(slide: Slide, pile: Pile, slot: (i: number) => number): LayoutPatch {
  const patch: LayoutPatch = {
    layout: { type: "custom", rects: slide.cells.map((_, i) => pile.rects[slot(i)]) },
    cells: slide.cells.map((c, i) => ({
      ...c,
      rotation: pile.angles[slot(i)],
      border: c.border ?? { ...SCATTER_BORDER },
    })),
  };
  // The pile sits on a surface, not a void: ground it on the hero's own
  // blur unless the user already chose a background.
  if (slide.background.type === "default") {
    patch.background = { type: "blur", cell: 0, sigma: 0.02, dim: 0.35 };
  }
  return patch;
}

/** Scatter with the pile arranged around the faces: every variant and every
 * slot assignment is scored — face area hidden under later-drawn prints
 * costs, big faces on big slots pay off — and the global best wins.
 * Deterministic: ties keep the earliest variant and plainest deal. */
export function smartScatterPatch(slide: Slide, media: MediaItem[]): LayoutPatch | null {
  const n = slide.cells.length;
  const piles = SCATTER_PILES[n];
  if (!piles || piles.length === 0) return null;
  const aspects = cellAspects(slide, media);

  const score = (pile: Pile, assignment: number[]): number => {
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

  const perms = assignmentsFor(n);
  let bestPile = piles[0];
  let best = perms[0];
  let bestScore = Infinity;
  for (const pile of piles) {
    for (const p of perms) {
      const s = score(pile, p);
      if (s < bestScore - 1e-9) {
        bestScore = s;
        bestPile = pile;
        best = p;
      }
    }
  }

  return scatterPatch(slide, bestPile, (i) => best[i]);
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

/** Swap two photos' positions on the slide — the manual counterpart of
 * smart dealing. On a custom layout (scatter, quilts, hand-edits) the slots
 * and tilts trade places while cell order — stacking, the member strip —
 * stays put. On ordered layouts position IS the cell order, so the cells
 * themselves trade places. */
export function swapPositions(slide: Slide, a: number, b: number): Partial<Slide> | null {
  if (a === b || !slide.cells[a] || !slide.cells[b]) return null;
  if (slide.layout.type === "custom") {
    const rects = [...slide.layout.rects];
    if (!rects[a] || !rects[b]) return null;
    [rects[a], rects[b]] = [rects[b], rects[a]];
    const cells = slide.cells.map((c, i) =>
      i === a
        ? { ...c, rotation: slide.cells[b].rotation }
        : i === b
          ? { ...c, rotation: slide.cells[a].rotation }
          : c,
    );
    return { layout: { type: "custom", rects }, cells };
  }
  const cells = [...slide.cells];
  [cells[a], cells[b]] = [cells[b], cells[a]];
  return { cells };
}

/** The plain (table-order) deal of whichever variant the slide currently
 * uses — so leaving Smart lands back on the same composition. */
export function plainScatterPatch(slide: Slide): LayoutPatch | null {
  const piles = SCATTER_PILES[slide.cells.length] ?? [];
  if (piles.length === 0) return null;
  let match = piles[0];
  if (slide.layout.type === "custom") {
    const key = (r: NormRect) => JSON.stringify(r);
    const used = new Set(slide.layout.rects.map(key));
    const found = piles.find((pile) => {
      const slots = new Set(pile.rects.map(key));
      return slots.size === used.size && [...used].every((k) => slots.has(k));
    });
    if (found) match = found;
  }
  return scatterPatch(slide, match, (i) => i);
}

/** The pile variants available at this member count, for the manual variant
 * row: geometry for the mini-diagrams plus a short numeral label. */
export function scatterVariants(
  n: number,
): { rects: NormRect[]; angles: number[]; label: string }[] {
  return (SCATTER_PILES[n] ?? []).map((pile, vi) => ({
    rects: pile.rects,
    angles: pile.angles,
    label: ["I", "II", "III", "IV"][vi] ?? `${vi + 1}`,
  }));
}

/** Which pile variant the slide's slots come from (any deal), -1 if none. */
export function activeScatterVariant(slide: Slide): number {
  const piles = SCATTER_PILES[slide.cells.length] ?? [];
  if (slide.layout.type !== "custom") return -1;
  const key = (r: NormRect) => JSON.stringify(r);
  const used = new Set(slide.layout.rects.map(key));
  return piles.findIndex((pile) => {
    const slots = new Set(pile.rects.map(key));
    return slots.size === used.size && [...used].every((k) => slots.has(k));
  });
}

/** The plain (table-order) deal of one specific variant — the manual pick. */
export function scatterVariantPatch(slide: Slide, vi: number): LayoutPatch | null {
  const pile = (SCATTER_PILES[slide.cells.length] ?? [])[vi];
  return pile ? scatterPatch(slide, pile, (i) => i) : null;
}

/** Whether the slide is on scatter at all, and which flavor: some variant's
 * plain table order, a smart (permuted) deal of some variant, or not
 * scatter. */
export function scatterState(slide: Slide): "off" | "plain" | "smart" {
  const piles = SCATTER_PILES[slide.cells.length] ?? [];
  if (slide.layout.type !== "custom") return "off";
  const current = slide.layout.rects;
  const key = (r: NormRect) => JSON.stringify(r);
  const used = new Set(current.map(key));
  for (const pile of piles) {
    if (current.length !== pile.rects.length) continue;
    if (JSON.stringify(current) === JSON.stringify(pile.rects)) return "plain";
    const slots = new Set(pile.rects.map(key));
    if (slots.size === used.size && [...used].every((k) => slots.has(k))) return "smart";
  }
  return "off";
}
