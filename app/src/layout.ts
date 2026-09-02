// TypeScript mirror of layout_rects (crates/slideshow-core/src/layout.rs) for
// composing slide-card thumbnails. Display-only: the renderer's Rust version
// stays the authority for pixels. Keep the math in lockstep with layout.rs.

import type { Layout, NormRect, Side } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One rect per cell (up to `nCells`) inside a `frameW`×`frameH` frame.
 * `margin` and `gutter` are fractions of min(frameW, frameH). */
export function layoutRects(
  layout: Layout,
  nCells: number,
  frameW: number,
  frameH: number,
  margin: number,
  gutter: number,
): Rect[] {
  if (nCells === 0) return [];
  const minDim = Math.min(frameW, frameH);
  const m = Math.max(margin, 0) * minDim;
  const g = Math.max(gutter, 0) * minDim;
  const area: Rect = {
    x: m,
    y: m,
    w: Math.max(frameW - 2 * m, 1),
    h: Math.max(frameH - 2 * m, 1),
  };

  switch (layout.type) {
    case "single":
      return [area];
    case "rows":
      return split(area, nCells, layout.weights, g, false);
    case "columns":
      return split(area, nCells, layout.weights, g, true);
    case "grid":
      return grid(area, nCells, layout.rows, layout.cols, g);
    case "featured":
      return featured(area, nCells, layout.side, layout.ratio, g);
    case "spotlight":
      return spotlight(area, nCells, layout.ratio, g);
    case "mosaic":
      return mosaic(area, nCells, layout.aspects, g);
    case "custom":
      return layout.rects.slice(0, nCells).map(
        (r: NormRect): Rect => ({
          x: area.x + r.x * area.w,
          y: area.y + r.y * area.h,
          w: r.w * area.w,
          h: r.h * area.h,
        }),
      );
  }
}

function split(area: Rect, n: number, weights: number[], gutter: number, vertical: boolean): Rect[] {
  const count = Math.max(n, 1);
  const w = Array.from({ length: count }, (_, i) => {
    const v = weights[i];
    return v !== undefined && v > 0 ? v : 1;
  });
  const total = w.reduce((a, b) => a + b, 0);
  const span = Math.max((vertical ? area.w : area.h) - gutter * (count - 1), 1);

  const out: Rect[] = [];
  let cursor = vertical ? area.x : area.y;
  for (const wi of w) {
    const size = (span * wi) / total;
    out.push(
      vertical
        ? { x: cursor, y: area.y, w: size, h: area.h }
        : { x: area.x, y: cursor, w: area.w, h: size },
    );
    cursor += size + gutter;
  }
  return out;
}

function grid(area: Rect, n: number, rows: number, cols: number, gutter: number): Rect[] {
  const r = Math.max(rows, 1);
  const c = Math.max(cols, 1);
  const count = Math.min(n, r * c);
  const cw = (area.w - gutter * (c - 1)) / c;
  const ch = (area.h - gutter * (r - 1)) / r;
  return Array.from({ length: count }, (_, i) => ({
    x: area.x + (i % c) * (cw + gutter),
    y: area.y + Math.floor(i / c) * (ch + gutter),
    w: cw,
    h: ch,
  }));
}

/** Cell 0 large in the center; the rest flank it left and right (extras go
 * right). Lockstep with `spotlight` in layout.rs. */
function spotlight(area: Rect, n: number, ratio: number, gutter: number): Rect[] {
  if (n === 1) return [area];
  const r = Math.min(Math.max(ratio, 0.2), 0.8);
  const leftN = Math.floor((n - 1) / 2);
  const rightN = n - 1 - leftN;
  const cols = 1 + (leftN > 0 ? 1 : 0) + (rightN > 0 ? 1 : 0);
  const avail = area.w - gutter * (cols - 1);
  const mainW = avail * r;
  const flankW = (avail - mainW) / (cols - 1);
  const leftW = leftN > 0 ? flankW : 0;
  const mainX = area.x + (leftN > 0 ? leftW + gutter : 0);

  const out: Rect[] = [{ x: mainX, y: area.y, w: mainW, h: area.h }];
  if (leftN > 0)
    out.push(...split({ x: area.x, y: area.y, w: leftW, h: area.h }, leftN, [], gutter, false));
  if (rightN > 0)
    out.push(
      ...split({ x: mainX + mainW + gutter, y: area.y, w: flankW, h: area.h }, rightN, [], gutter, false),
    );
  return out;
}

/** Aspect-aware justified rows, deterministic in member order. Lockstep
 * with `mosaic` in layout.rs. */
function mosaic(area: Rect, n: number, aspects: number[], gutter: number): Rect[] {
  if (n === 1) return [area];
  const a = Array.from({ length: n }, (_, i) => {
    const v = aspects[i];
    return v !== undefined && v > 0 ? v : 1.5;
  });
  const total = a.reduce((x, y) => x + y, 0);
  const avg = total / n;
  const rows = Math.min(Math.max(Math.round(Math.sqrt((n * area.h * avg) / Math.max(area.w, 1))), 1), n);

  const target = total / rows;
  const rowCells: number[] = [];
  let i = 0;
  for (let k = 0; k < rows; k++) {
    const rowsLeft = rows - k;
    const maxTake = n - i - (rowsLeft - 1);
    let acc = 0;
    let take = 0;
    while (take < maxTake && (take === 0 || acc + a[i + take] / 2 <= target)) {
      acc += a[i + take];
      take += 1;
    }
    rowCells.push(take);
    i += take;
  }
  if (i < n) rowCells[rowCells.length - 1] += n - i;

  const sums: number[] = [];
  {
    let c = 0;
    for (const cnt of rowCells) {
      sums.push(Math.max(a.slice(c, c + cnt).reduce((x, y) => x + y, 0), 0.01));
      c += cnt;
    }
  }
  const raw = sums.map((s) => area.w / s);
  const rawTotal = raw.reduce((x, y) => x + y, 0);
  const scale = Math.max(area.h - gutter * (rows - 1), 1) / Math.max(rawTotal, 0.01);

  const out: Rect[] = [];
  let y = area.y;
  let c = 0;
  rowCells.forEach((cnt, k) => {
    const h = raw[k] * scale;
    const avail = area.w - gutter * (cnt - 1);
    let x = area.x;
    for (let j = 0; j < cnt; j++) {
      const w = (avail * a[c + j]) / sums[k];
      out.push({ x, y, w, h });
      x += w + gutter;
    }
    c += cnt;
    y += h + gutter;
  });
  return out;
}

function featured(area: Rect, n: number, side: Side, ratio: number, gutter: number): Rect[] {
  if (n === 1) return [area];
  const r = Math.min(Math.max(ratio, 0.1), 0.9);
  const horizontal = side === "left" || side === "right";
  let main: Rect;
  let strip: Rect;
  if (horizontal) {
    const mainW = (area.w - gutter) * r;
    const stripW = area.w - gutter - mainW;
    const mx = side === "left" ? area.x : area.x + stripW + gutter;
    const sx = side === "left" ? area.x + mainW + gutter : area.x;
    main = { x: mx, y: area.y, w: mainW, h: area.h };
    strip = { x: sx, y: area.y, w: stripW, h: area.h };
  } else {
    const mainH = (area.h - gutter) * r;
    const stripH = area.h - gutter - mainH;
    const my = side === "top" ? area.y : area.y + stripH + gutter;
    const sy = side === "top" ? area.y + mainH + gutter : area.y;
    main = { x: area.x, y: my, w: area.w, h: mainH };
    strip = { x: area.x, y: sy, w: area.w, h: stripH };
  }
  return [main, ...split(strip, n - 1, [], gutter, !horizontal)];
}
