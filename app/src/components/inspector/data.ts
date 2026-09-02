// Shared vocabulary between the outcome verbs and the Values pane.

import type { Cell, Layout, TransitionKind } from "../../types";

export const LAYOUTS: { label: string; make: (n: number) => Layout }[] = [
  { label: "Single", make: () => ({ type: "single" }) },
  { label: "Columns", make: () => ({ type: "columns", weights: [] }) },
  { label: "Rows", make: () => ({ type: "rows", weights: [] }) },
  { label: "Grid 2×2", make: () => ({ type: "grid", rows: 2, cols: 2 }) },
  { label: "Grid 3×3", make: () => ({ type: "grid", rows: 3, cols: 3 }) },
  { label: "Featured ◧", make: () => ({ type: "featured", side: "left", ratio: 0.62 }) },
  { label: "Featured ◨", make: () => ({ type: "featured", side: "right", ratio: 0.62 }) },
];

/** Where a fresh zoom should aim: the cell's own origin if it already
 * zooms, else the detected face region's center, else dead center. */
function zoomOrigin(c: Cell): [number, number] {
  if (c.motion.type === "zoom") return c.motion.origin;
  if (c.smart_focus)
    return [c.smart_focus.x + c.smart_focus.w / 2, c.smart_focus.y + c.smart_focus.h / 2];
  return [0.5, 0.5];
}

export const MOTIONS: { label: string; value: (c: Cell) => Cell["motion"] }[] = [
  { label: "None", value: () => ({ type: "none" }) },
  {
    label: "Zoom in",
    value: (c) => ({ type: "zoom", from: 1.0, to: 1.15, origin: zoomOrigin(c) }),
  },
  {
    label: "Zoom out",
    value: (c) => ({ type: "zoom", from: 1.15, to: 1.0, origin: zoomOrigin(c) }),
  },
  {
    label: "Pan →",
    value: () => ({
      type: "ken_burns",
      from: { x: 0, y: 0.05, w: 0.9, h: 0.9 },
      to: { x: 0.1, y: 0.05, w: 0.9, h: 0.9 },
    }),
  },
  {
    label: "Pan ↓",
    value: () => ({
      type: "ken_burns",
      from: { x: 0.05, y: 0, w: 0.9, h: 0.9 },
      to: { x: 0.05, y: 0.1, w: 0.9, h: 0.9 },
    }),
  },
];

export function motionLabel(m: Cell["motion"]): string {
  if (m.type === "none") return "None";
  if (m.type === "zoom") return m.to >= m.from ? "Zoom in" : "Zoom out";
  return m.from.x !== m.to.x ? "Pan →" : "Pan ↓";
}

export function kindLabel(k: TransitionKind): string {
  switch (k.type) {
    case "cut":
      return "Cut";
    case "cross_fade":
      return "Crossfade";
    case "fade_black":
      return "Fade through black";
    case "fade_white":
      return "Fade through white";
    case "slide":
      return "Slide";
    case "wipe":
      return "Wipe";
  }
}
