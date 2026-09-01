import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { revealPath } from "../api";
import { layoutRects } from "../layout";
import { ensureAudioCtx, mixForRev } from "../mixcache";
import {
  ANCHOR_POINTS,
  audioTrackFor,
  autoLayout,
  bindSlides,
  defaultSlide,
  defaultText,
  dissolveGroup,
  freshId,
  GROUP_MAX,
  membersOf,
  slideForCell,
  slideForMedia,
  slideForText,
} from "../presets";
import type { Member } from "../presets";
import { useEditor } from "../store";
import type { Cell, MediaInfo, MediaItem, Slide } from "../types";

/**
 * The timeline — the mode-carrying surface under the frame. Arrange is a
 * wrapping grid of equal-width slide cards in playback order: drag or use the
 * keyboard to reorder, drop a card onto another to bind them into one slide,
 * press ↵ on a group to open it as a full-width band. Time (groundwork for
 * the proportional view) stretches the same cards to their durations.
 */

/** What a pointer drag is carrying. */
type DragPayload =
  | { kind: "slide"; index: number }
  | { kind: "media"; path: string }
  | { kind: "member"; slide: number; member: Member }
  | { kind: "text" };

type MenuEntry = { label: string; disabled?: boolean; onPick: () => void } | "sep";

/** Time mode's ruler scale: one second of film is this many pixels. */
const PX_PER_SEC = 24;
/** Height of a card's picture area in the proportional strip. */
const TIME_THUMB_H = 76;

const TRANSITION_NAMES: Record<string, string> = {
  cut: "Cut",
  cross_fade: "Crossfade",
  fade_black: "Fade through black",
  fade_white: "Fade through white",
  slide: "Slide",
  wipe: "Wipe",
};

function fmtClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Min/max peaks of the mix drawn into the lane canvas. `vertical` runs the
 * time axis top-to-bottom (side-docked timeline). */
function drawWaveform(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer | null,
  cssLength: number,
  vertical: boolean,
) {
  const len = Math.max(1, Math.min(Math.round(cssLength), 8192));
  const thick = 56;
  canvas.width = vertical ? thick : len;
  canvas.height = vertical ? len : thick;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!buffer) return;
  const data = buffer.getChannelData(0);
  const step = data.length / len;
  g.fillStyle = "rgba(212, 175, 110, 0.55)";
  const mid = thick / 2;
  for (let pos = 0; pos < len; pos++) {
    let min = 0;
    let max = 0;
    const from = Math.floor(pos * step);
    const to = Math.min(Math.floor((pos + 1) * step), data.length);
    for (let i = from; i < to; i += 4) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const lo = mid + min * mid;
    const span = Math.max((max - min) * mid, 1);
    if (vertical) g.fillRect(lo, pos, span, 1);
    else g.fillRect(pos, lo, 1, span);
  }
}

type DropZone =
  | { kind: "bind"; index: number }
  | { kind: "insert"; index: number }
  | { kind: "band" }
  | { kind: "band-member"; index: number };

/** Thumbnail lookup for cells and shelf items. */
function useThumbs(): Map<string, MediaItem> {
  const media = useEditor((s) => s.media);
  return useMemo(() => new Map(media.map((m) => [m.path, m])), [media]);
}

function cellThumb(cell: Cell, thumbs: Map<string, MediaItem>): string | null {
  if (cell.source.type === "solid") return null;
  const m = thumbs.get(cell.source.path);
  return m && m.status === "ready" ? m.thumb : null;
}

function cellInfo(cell: Cell, thumbs: Map<string, MediaItem>): MediaInfo | undefined {
  if (cell.source.type === "solid") return undefined;
  const m = thumbs.get(cell.source.path);
  return m && m.status === "ready" ? m.info : undefined;
}

/** A slide's real composed layout at card scale — every member, never a
 * stand-in. `receiving` re-composes with one empty seat: the card visibly
 * opening to receive a drop. */
function SlideThumb({
  slide,
  thumbs,
  aspect,
  receiving = false,
  fill = false,
}: {
  slide: Slide;
  thumbs: Map<string, MediaItem>;
  aspect: number;
  receiving?: boolean;
  /** Fill the parent box instead of imposing an aspect ratio (the box's own
   * proportions should then match `aspect`). */
  fill?: boolean;
}) {
  const n = slide.cells.length + (receiving ? 1 : 0);
  const layout = receiving ? autoLayout(n) : slide.layout;
  const W = 160;
  const H = W / aspect;
  const margin = receiving ? 0.04 : slide.margin;
  const rects = layoutRects(layout, n, W, H, margin, slide.gutter);

  return (
    <div
      className="slide-thumb"
      style={fill ? { width: "100%", height: "100%" } : { aspectRatio: `${aspect}` }}
    >
      {slide.cells.map((cell, i) => {
        const r = rects[i];
        if (!r) return null;
        const thumb = cellThumb(cell, thumbs);
        return (
          <div
            key={i}
            className="thumb-cell"
            style={{
              left: `${(r.x / W) * 100}%`,
              top: `${(r.y / H) * 100}%`,
              width: `${(r.w / W) * 100}%`,
              height: `${(r.h / H) * 100}%`,
            }}
          >
            {thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="thumb-empty" />}
          </div>
        );
      })}
      {receiving && rects[n - 1] && (
        <div
          className="thumb-cell thumb-seat"
          style={{
            left: `${(rects[n - 1].x / W) * 100}%`,
            top: `${(rects[n - 1].y / H) * 100}%`,
            width: `${(rects[n - 1].w / W) * 100}%`,
            height: `${(rects[n - 1].h / H) * 100}%`,
          }}
        />
      )}
      {slide.texts.slice(0, 3).map((t, i) => {
        if (!t.text.trim()) return null;
        const [ax, ay] = ANCHOR_POINTS[t.anchor] ?? [0.5, 0.5];
        const fx = Math.min(Math.max(ax + t.offset[0], 0), 1);
        const fy = Math.min(Math.max(ay + t.offset[1], 0), 1);
        return (
          <span
            key={`t${i}`}
            className="thumb-text"
            style={{
              left: `${fx * 100}%`,
              top: `${fy * 100}%`,
              transform: `translate(${-ax * 100}%, ${-ay * 100}%)`,
              fontSize: `${Math.max(t.size * 100, 7)}cqh`,
              fontWeight: t.weight >= 600 ? 700 : 400,
              fontStyle: t.italic ? "italic" : "normal",
              color: t.color,
            }}
          >
            {t.text}
          </span>
        );
      })}
    </div>
  );
}

/**
 * `face` pins the panel to one mode (split layout renders two instances:
 * Arrange on the left, Time at the bottom). Without it the panel carries the
 * mode toggle and follows the store's mode.
 */
export default function Timeline({
  onImport,
  face,
}: {
  onImport: () => void;
  face?: "arrange" | "time";
}) {
  const project = useEditor((s) => s.project);
  const selected = useEditor((s) => s.selectedSlide);
  const selectSlide = useEditor((s) => s.selectSlide);
  const selectedIds = useEditor((s) => s.selectedIds);
  const setSelection = useEditor((s) => s.setSelection);
  const selectText = useEditor((s) => s.selectText);
  const mutate = useEditor((s) => s.mutate);
  const media = useEditor((s) => s.media);
  const removeMedia = useEditor((s) => s.removeMedia);
  const storeMode = useEditor((s) => s.mode);
  const setMode = useEditor((s) => s.setMode);
  const mode = face ?? storeMode;
  const timing = useEditor((s) => s.timing);
  const playSlide = useEditor((s) => s.playSlide);
  const time = useEditor((s) => s.time);
  const setTime = useEditor((s) => s.setTime);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const rev = useEditor((s) => s.rev);
  const dock = useEditor((s) => s.ui.dock);
  const setUi = useEditor((s) => s.setUi);
  const thumbs = useThumbs();
  /** Side-docked Time mode runs the clock top-to-bottom. A pinned Time face
   * (split layout) always sits at the bottom, so it stays horizontal. */
  const vertical = mode === "time" && dock !== "bottom" && !face;

  const slides = project.slides;
  const aspect = project.settings.width / Math.max(project.settings.height, 1);

  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const [memberFocus, setMemberFocus] = useState(0);
  const [drop, setDrop] = useState<DropZone | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [shelfOpen, setShelfOpen] = useState(true);
  const [cols, setCols] = useState(6);
  const [panelW, setPanelW] = useState(280);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const bandRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<number, HTMLDivElement>());

  // ---- derived group/band state ----
  const openIdx = openGroupId === null ? -1 : slides.findIndex((s) => s.id === openGroupId);
  const openGroup =
    openIdx >= 0 && membersOf(slides[openIdx]).length > 1 ? slides[openIdx] : null;
  useEffect(() => {
    // The group left the timeline or dissolved — the band follows it out.
    if (openGroupId !== null && !openGroup) setOpenGroupId(null);
  }, [openGroupId, openGroup]);

  // ---- columns: measured, so the band lands after the group's real row ----
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      setPanelW(el.clientWidth);
      const cards = [...el.querySelectorAll<HTMLElement>(".slide-card")];
      if (cards.length < 2) return;
      const top = cards[0].offsetTop;
      let count = 0;
      for (const c of cards) {
        if (Math.abs(c.offsetTop - top) > 4) break;
        count++;
      }
      if (count > 0) setCols(count);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [slides.length, mode]);

  // ---- the mode switch: one animated reflow (FLIP over the same cards) ----
  const flipRects = useRef<Map<string, DOMRect> | null>(null);
  const switchMode = (m: "arrange" | "time") => {
    if (m === mode) return;
    const rects = new Map<string, DOMRect>();
    for (const [i, el] of cardRefs.current) {
      const id = slides[i]?.id;
      if (id) rects.set(id, el.getBoundingClientRect());
    }
    flipRects.current = rects;
    setOpenGroupId(null);
    setMode(m);
    // The signature moment: cards stretch to their true lengths, the audio
    // lane rises, and the music starts. Leaving Time pauses it again.
    setPlaying(m === "time" && slides.length > 0);
  };

  useLayoutEffect(() => {
    const prev = flipRects.current;
    if (!prev) return;
    flipRects.current = null;
    for (const [i, el] of cardRefs.current) {
      const id = slides[i]?.id;
      const from = id ? prev.get(id) : undefined;
      if (!from) continue;
      const to = el.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      const sx = from.width / Math.max(to.width, 1);
      const sy = from.height / Math.max(to.height, 1);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.02 && Math.abs(sy - 1) < 0.02)
        continue;
      // Off-screen on both ends (a 300-card grid): nothing to show, skip.
      const off = (r: DOMRect) =>
        r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
      if (off(from) && off(to)) continue;
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: "top left" },
          { transform: "none", transformOrigin: "top left" },
        ],
        { duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
  }, [mode]);

  // ---- time mode: proportional geometry from the backend's timing ----
  const total = timing?.total ?? slides.reduce((a, s) => a + s.duration, 0);
  const { widths, lefts } = useMemo(() => {
    const spans = timing?.spans;
    const ws = slides.map((s, i) => {
      if (spans && spans.length === slides.length) {
        const next = i + 1 < spans.length ? spans[i + 1].start : total;
        return Math.max((next - spans[i].start) * PX_PER_SEC, 24);
      }
      return Math.max(s.duration * PX_PER_SEC, 24);
    });
    const ls: number[] = [];
    let x = 0;
    for (const w of ws) {
      ls.push(x);
      x += w;
    }
    return { widths: ws, lefts: ls };
  }, [slides, timing, total]);
  const contentW = Math.max(total * PX_PER_SEC, 1);

  // The audio lane draws the real mix — the same PCM the preview plays.
  const laneRef = useRef<HTMLCanvasElement | null>(null);
  const [hasMix, setHasMix] = useState(false);
  useEffect(() => {
    if (mode !== "time") return;
    let dead = false;
    void mixForRev(ensureAudioCtx(), rev)
      .then((buffer) => {
        if (dead) return;
        setHasMix(!!buffer);
        if (laneRef.current) drawWaveform(laneRef.current, buffer, contentW, vertical);
      })
      .catch(() => setHasMix(false));
    return () => {
      dead = true;
    };
  }, [mode, rev, contentW, vertical]);

  // Scrubbing on the ruler: proportional position is the playhead.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const seekAt = useCallback(
    (e: React.PointerEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const pos = vertical ? e.clientY - rect.top : e.clientX - rect.left;
      setTime(Math.max(0, pos / PX_PER_SEC));
    },
    [setTime, vertical],
  );

  // Playback keeps the playhead in view.
  useEffect(() => {
    if (mode !== "time" || !playing) return;
    const strip = stripRef.current;
    if (!strip) return;
    const x = time * PX_PER_SEC;
    if (vertical) {
      if (x < strip.scrollTop + 40 || x > strip.scrollTop + strip.clientHeight - 80) {
        strip.scrollTop = Math.max(0, x - strip.clientHeight * 0.3);
      }
    } else if (x < strip.scrollLeft + 40 || x > strip.scrollLeft + strip.clientWidth - 80) {
      strip.scrollLeft = Math.max(0, x - strip.clientWidth * 0.3);
    }
  }, [time, playing, mode, vertical]);

  // ---- the "Not used" shelf: imported media the film doesn't reference ----
  const usedPaths = useMemo(() => {
    const used = new Set<string>();
    for (const s of slides)
      for (const c of s.cells)
        if (c.source.type === "image" || c.source.type === "video") used.add(c.source.path);
    for (const a of project.audio) used.add(a.path);
    return used;
  }, [slides, project.audio]);
  const unused = media.filter((m) => !usedPaths.has(m.path));

  // ---- structural operations ----
  /** Re-renders replace card nodes, so focus is re-seated after the commit. */
  const focusCard = (i: number) => {
    requestAnimationFrame(() => cardRefs.current.get(i)?.focus());
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= slides.length || from === to) return;
    mutate((p) => {
      const next = [...p.slides];
      const [s] = next.splice(from, 1);
      next.splice(to, 0, s);
      return { ...p, slides: next };
    });
    selectSlide(to, false);
    focusCard(to);
  };

  const duplicate = (i: number) => {
    const s = slides[i];
    if (!s) return;
    mutate((p) => {
      const copy: Slide = { ...JSON.parse(JSON.stringify(s)) as Slide, id: freshId("slide") };
      const next = [...p.slides];
      next.splice(i + 1, 0, copy);
      return { ...p, slides: next };
    });
    selectSlide(i + 1, false);
    focusCard(i + 1);
  };

  const insertSlides = (at: number, fresh: Slide[]) => {
    if (!fresh.length) return;
    mutate((p) => {
      const next = [...p.slides];
      next.splice(at, 0, ...fresh);
      return { ...p, slides: next };
    });
    selectSlide(at, false);
  };

  const removeSlide = (i: number) => {
    mutate((p) => ({ ...p, slides: p.slides.filter((_, j) => j !== i) }));
    selectSlide(Math.min(i, slides.length - 2), false);
  };

  const reorder = (from: number, insertAt: number) => {
    const to = insertAt > from ? insertAt - 1 : insertAt;
    move(from, to);
  };

  /** Bind: source slide's members — photos and titles — join the target. */
  const bind = (targetIdx: number, sourceIdx: number) => {
    if (targetIdx === sourceIdx) return;
    const target = slides[targetIdx];
    const source = slides[sourceIdx];
    if (target.cells.length + source.cells.length > GROUP_MAX) return;
    if (membersOf(source).length === 0) return;
    mutate((p) => {
      const next = p.slides
        .map((s, i) => (i === targetIdx ? bindSlides(target, source) : s))
        .filter((_, i) => i !== sourceIdx);
      return { ...p, slides: next };
    });
    selectSlide(targetIdx > sourceIdx ? targetIdx - 1 : targetIdx, false);
  };

  /** Bind a shelf photo straight into a slide as a new cell. */
  const bindMedia = (targetIdx: number, path: string) => {
    const m = thumbs.get(path);
    if (!m || m.status !== "ready" || (!m.info.is_image && !m.info.has_video)) return;
    const target = slides[targetIdx];
    if (target.cells.length + 1 > GROUP_MAX) return;
    mutate((p) => ({
      ...p,
      slides: p.slides.map((s, i) =>
        i === targetIdx ? bindSlides(target, slideForMedia(m)) : s,
      ),
    }));
  };

  /** Split one member — photo or title — out of a group: it re-enters the
   * timeline as its own slide directly after. A lone photo left behind
   * becomes an ordinary slide again. */
  const splitMember = (slideIdx: number, member: Member) => {
    const group = slides[slideIdx];
    if (membersOf(group).length < 2) return;
    let remaining: Slide;
    let lifted: Slide;
    if (member.type === "cell") {
      const cell = group.cells[member.index];
      if (!cell) return;
      const rest = group.cells.filter((_, i) => i !== member.index);
      remaining = { ...group, cells: rest, layout: autoLayout(rest.length) };
      lifted = slideForCell(cell, cellInfo(cell, thumbs));
    } else {
      const text = group.texts[member.index];
      if (!text) return;
      remaining = { ...group, texts: group.texts.filter((_, i) => i !== member.index) };
      lifted = slideForText(text);
    }
    if (remaining.cells.length === 1 && remaining.texts.length === 0) {
      remaining = dissolveGroup(remaining, cellInfo(remaining.cells[0], thumbs));
    }
    mutate((p) => {
      const next = [...p.slides];
      next.splice(slideIdx, 1, remaining, lifted);
      return { ...p, slides: next };
    });
    setMemberFocus((f) => Math.max(0, Math.min(f, membersOf(remaining).length - 1)));
  };

  const addEmpty = () => insertSlides(slides.length, [defaultSlide()]);

  // ---- multi-selection ----
  const selectedIdxs = useMemo(
    () =>
      selectedIds
        .map((id) => slides.findIndex((s) => s.id === id))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b),
    [selectedIds, slides],
  );
  const shiftAnchor = useRef<number | null>(null);

  const rangeIds = (a: number, b: number) =>
    slides.slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => s.id);

  const clickCard = (e: React.MouseEvent, i: number) => {
    if (e.metaKey || e.ctrlKey) {
      const id = slides[i].id;
      const ids = selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id];
      setSelection(ids.length ? ids : [id], i);
      shiftAnchor.current = i;
    } else if (e.shiftKey) {
      const a = shiftAnchor.current ?? selected;
      setSelection(rangeIds(a, i), i);
    } else {
      shiftAnchor.current = i;
      selectSlide(i);
    }
  };

  /** Hide: the slides leave the film; their photos stay on the shelf. */
  const hideSlides = (idxs: number[]) => {
    if (!idxs.length) return;
    const drop = new Set(idxs);
    mutate((p) => ({ ...p, slides: p.slides.filter((_, i) => !drop.has(i)) }));
    selectSlide(Math.max(0, Math.min(idxs[0], slides.length - idxs.length - 1)), false);
  };

  const duplicateSlides = (idxs: number[]) => {
    if (!idxs.length) return;
    const copies = idxs.map((i): Slide => ({
      ...(JSON.parse(JSON.stringify(slides[i])) as Slide),
      id: freshId("slide"),
    }));
    insertSlides(idxs[idxs.length - 1] + 1, copies);
  };

  /** Merge the selection into one group slide at the earliest position —
   * photos join the collage, titles join the text layer. */
  const mergeSlides = (idxs: number[]) => {
    const withMembers = idxs.filter((i) => membersOf(slides[i]).length > 0);
    const cells = withMembers.flatMap((i) => slides[i].cells);
    const texts = withMembers.flatMap((i) => slides[i].texts);
    if (withMembers.length < 2 || cells.length > GROUP_MAX) return;
    const targetIdx = withMembers[0];
    const target = slides[targetIdx];
    const drop = new Set(withMembers.slice(1));
    mutate((p) => ({
      ...p,
      slides: p.slides
        .map((s, i) =>
          i === targetIdx
            ? {
                ...target,
                cells: cells.map((c): Cell => ({ ...c, fit: "cover", motion: { type: "none" } })),
                texts,
                layout: autoLayout(cells.length),
                margin: cells.length > 1 ? 0.04 : target.margin,
                gutter: 0.02,
                background: cells.length > 1 ? { type: "default" as const } : target.background,
              }
            : s,
        )
        .filter((_, i) => !drop.has(i)),
    }));
    selectSlide(targetIdx, false);
  };

  /** Move a member within its group (same kind only: photos order the
   * collage, titles order the text stack). */
  const reorderMember = (m: Member, targetMemberIdx: number) => {
    if (openIdx < 0 || !openGroup) return;
    const target = membersOf(openGroup)[targetMemberIdx];
    if (!target || target.type !== m.type || target.index === m.index) return;
    mutate((p) => ({
      ...p,
      slides: p.slides.map((s, i) => {
        if (i !== openIdx) return s;
        if (m.type === "cell") {
          const cells = [...s.cells];
          const [c] = cells.splice(m.index, 1);
          cells.splice(target.index, 0, c);
          return { ...s, cells };
        }
        const texts = [...s.texts];
        const [t] = texts.splice(m.index, 1);
        texts.splice(target.index, 0, t);
        return { ...s, texts };
      }),
    }));
    setMemberFocus(targetMemberIdx);
  };

  /** Explode a group: every member — photo or title — becomes its own slide
   * in place; the first part inherits the slide's identity and timing. */
  const splitApart = (i: number) => {
    const group = slides[i];
    if (membersOf(group).length < 2) return;
    mutate((p) => {
      const parts: Slide[] = [
        ...group.cells.map((c) => slideForCell(c, cellInfo(c, thumbs))),
        ...group.texts.map((t) => slideForText(t)),
      ];
      parts[0] = { ...parts[0], id: group.id, duration: group.duration, transition: group.transition };
      const next = [...p.slides];
      next.splice(i, 1, ...parts);
      return { ...p, slides: next };
    });
    setOpenGroupId(null);
  };

  // ---- context menu ----
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent, entries: MenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 200), entries });
  };

  const cardMenu = (e: React.MouseEvent, i: number) => {
    const inSelection = selectedIds.includes(slides[i].id);
    const idxs = inSelection && selectedIdxs.length > 1 ? selectedIdxs : [i];
    if (!inSelection) {
      shiftAnchor.current = i;
      selectSlide(i, false);
    }
    const n = idxs.length;
    const s = slides[i];
    const entries: MenuEntry[] = [];
    if (n > 1) {
      const withCells = idxs.filter((j) => slides[j].cells.length > 0);
      const total = withCells.reduce((a, j) => a + slides[j].cells.length, 0);
      entries.push({
        label: `Group ${withCells.length} photos into one slide`,
        disabled: withCells.length < 2 || total > GROUP_MAX,
        onPick: () => mergeSlides(idxs),
      });
      entries.push({ label: `Duplicate ${n} slides`, onPick: () => duplicateSlides(idxs) });
      entries.push("sep");
      entries.push({ label: `Hide ${n} slides — move to “Not used”`, onPick: () => hideSlides(idxs) });
    } else {
      if (membersOf(s).length > 1) {
        entries.push({
          label: "Open group",
          onPick: () => {
            setOpenGroupId(s.id);
            setMemberFocus(0);
          },
        });
        entries.push({ label: `Split into ${membersOf(s).length} slides`, onPick: () => splitApart(i) });
        entries.push("sep");
      }
      entries.push({ label: "Play this slide", onPick: () => playSlide(i) });
      entries.push({ label: "Add title on this slide", onPick: () => addTitle(i) });
      entries.push({ label: "Duplicate", onPick: () => duplicate(i) });
      entries.push({ label: "Add blank slide after", onPick: () => insertSlides(i + 1, [defaultSlide()]) });
      entries.push("sep");
      entries.push({
        label: s.cells.length > 0 ? "Hide — move to “Not used”" : "Delete slide",
        onPick: () => hideSlides([i]),
      });
    }
    openMenu(e, entries);
  };

  const shelfMenu = (e: React.MouseEvent, m: MediaItem) => {
    const entries: MenuEntry[] = [];
    if (m.status === "ready" && (m.info.is_image || m.info.has_video)) {
      entries.push({ label: "Add to the timeline", onPick: () => insertSlides(slides.length, [slideForMedia(m)]) });
    }
    if (m.status === "ready" && m.info.has_audio && !m.info.has_video) {
      entries.push({ label: "Add as music", onPick: () => mutate((p) => ({ ...p, audio: [...p.audio, audioTrackFor(m)] })) });
    }
    entries.push({ label: "Reveal in Finder", onPick: () => void revealPath(m.path) });
    entries.push("sep");
    entries.push({ label: "Remove from project", onPick: () => removeMedia(m.path) });
    openMenu(e, entries);
  };

  const slideForShelfItem = (m: MediaItem): Slide | null =>
    m.status === "ready" && (m.info.is_image || m.info.has_video) ? slideForMedia(m) : null;

  // ---- drag handling ----
  // Pointer-event dragging, not HTML5 drag-and-drop: Tauri's window-level
  // drag handler (needed for OS file drops) swallows the webview's native
  // DnD events on macOS, so draggable/ondragover never fire for real mice.
  const dragStart = useRef<{ payload: DragPayload; x: number; y: number } | null>(null);
  const dropRef = useRef<DropZone | null>(null);
  const overRef = useRef<{ grid: boolean; shelf: boolean }>({ grid: false, shelf: false });
  const [ghost, setGhost] = useState<{
    x: number;
    y: number;
    label: string;
    kind: DragPayload["kind"];
    /** Whether the payload adds photos to a collage (drives the seat preview). */
    carriesCells: boolean;
  } | null>(null);
  const [shelfHot, setShelfHot] = useState(false);

  const setDropBoth = (z: DropZone | null) => {
    dropRef.current = z;
    setDrop(z);
  };

  const dragLabel = (p: DragPayload): string => {
    if (p.kind === "slide") {
      const s = slides[p.index];
      const n = s ? membersOf(s).length : 0;
      return n > 1 ? `Group of ${n}` : `Slide ${p.index + 1}`;
    }
    if (p.kind === "member") return p.member.type === "text" ? "Title" : "Photo";
    if (p.kind === "media") return p.path.replace(/^.*[/\\]/, "");
    if (p.kind === "text") return "Title";
    return "Photo";
  };

  const updateDragTarget = (x: number, y: number, payload: DragPayload) => {
    const els = document.elementsFromPoint(x, y);
    const overShelf = els.some((el) => el.classList.contains("shelf"));
    const overGrid = els.some((el) => el === gridRef.current);
    overRef.current = { grid: overGrid, shelf: overShelf };
    setShelfHot(overShelf && payload.kind === "slide");

    // The open band accepts drops: members join (or reorder inside) the group.
    const bandEl = els.find(
      (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("group-band"),
    );
    if (bandEl && openGroup) {
      if (payload.kind === "member") {
        if (payload.slide !== openIdx) {
          setDropBoth(null);
          return;
        }
        const tile = els.find(
          (el): el is HTMLElement =>
            el instanceof HTMLElement && el.classList.contains("band-member"),
        );
        const j = tile ? Number(tile.dataset.mi) : NaN;
        setDropBoth(Number.isNaN(j) ? null : { kind: "band-member", index: j });
        return;
      }
      if (payload.kind === "slide") {
        const src = slides[payload.index];
        const fits =
          payload.index !== openIdx &&
          src &&
          openGroup.cells.length + src.cells.length <= GROUP_MAX &&
          membersOf(src).length > 0;
        setDropBoth(fits ? { kind: "band" } : null);
        return;
      }
      if (payload.kind === "media") {
        setDropBoth(openGroup.cells.length < GROUP_MAX ? { kind: "band" } : null);
        return;
      }
      setDropBoth({ kind: "band" }); // a title always fits
      return;
    }
    if (payload.kind === "member") {
      // A member drop outside its band splits it out after the group.
      setDropBoth(null);
      return;
    }
    const cardEl = els.find(
      (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("slide-card"),
    );
    if (!cardEl) {
      setDropBoth(null);
      return;
    }
    const i = Number(cardEl.dataset.index);
    if (Number.isNaN(i)) {
      setDropBoth(null);
      return;
    }
    if (payload.kind === "text") {
      // A title lands on the whole card — photo, group, or blank alike.
      setDropBoth({ kind: "bind", index: i });
      return;
    }
    const r = cardEl.getBoundingClientRect();
    const frac = vertical
      ? (y - r.top) / Math.max(r.height, 1)
      : (x - r.left) / Math.max(r.width, 1);
    let zone: DropZone =
      frac < 0.25
        ? { kind: "insert", index: i }
        : frac > 0.75
          ? { kind: "insert", index: i + 1 }
          : { kind: "bind", index: i };
    if (zone.kind === "bind") {
      const sourceCells = payload.kind === "slide" ? slides[payload.index]?.cells.length ?? 1 : 1;
      const overfull = slides[i].cells.length + sourceCells > GROUP_MAX;
      const self = payload.kind === "slide" && payload.index === i;
      // A bind that would overfill (or target itself) falls back to inserting.
      if (overfull || self) zone = { kind: "insert", index: i + 1 };
    }
    setDropBoth(zone);
  };

  const beginDrag = (e: React.PointerEvent, payload: DragPayload) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input")) return;
    dragStart.current = { payload, x: e.clientX, y: e.clientY };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers have no capturable id; moves still bubble here.
    }
  };

  /** Add a centered title to slide `i`, show it in the frame, open its text. */
  const addTitle = (i: number) => {
    const s = slides[i];
    if (!s) return;
    const text = defaultText({
      text: "Title",
      role: "title",
      size: 0.08,
      anchor: "center",
      offset: [0, 0],
      fade: 0.6,
    });
    mutate((p) => ({
      ...p,
      slides: p.slides.map((sl, j) => (j === i ? { ...sl, texts: [...sl.texts, text] } : sl)),
    }));
    selectSlide(i, true);
    selectText(s.texts.length);
  };

  // Holding a drag near a scrollable edge auto-scrolls, speed ramping
  // quadratically as the pointer nears the edge. Interval-driven: a held
  // pointer emits no move events, and this webview suspends rAF whenever the
  // window isn't key, which would freeze the loop mid-drag.
  const autoScrollTimer = useRef<number | null>(null);
  const lastPoint = useRef({ x: 0, y: 0 });
  /** Sub-pixel speeds accumulate here — scrollTop truncates fractions. */
  const scrollCarry = useRef({ x: 0, y: 0 });
  // The tick lives across renders; always call the latest target logic.
  const updateTargetRef = useRef(updateDragTarget);
  updateTargetRef.current = updateDragTarget;

  const stopAutoScroll = useCallback(() => {
    if (autoScrollTimer.current !== null) {
      window.clearInterval(autoScrollTimer.current);
      autoScrollTimer.current = null;
    }
  }, []);

  const autoScrollTick = useCallback(() => {
    if (!dragStart.current) {
      stopAutoScroll();
      return;
    }
    const el = gridRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const T = 56; // the edge zone, px
    const MAX = 16; // px per tick at the very edge
    const { x, y } = lastPoint.current;
    const ramp = (dist: number) => {
      const p = Math.max(0, Math.min(1, 1 - dist / T));
      return p * p;
    };
    let sx = 0;
    let sy = 0;
    const inX = x > r.left - 40 && x < r.right + 40;
    const inY = y > r.top - 40 && y < r.bottom + 40;
    if (inX) {
      if (y < r.top + T && y > r.top - 40) sy = -MAX * ramp(y - r.top);
      else if (y > r.bottom - T && y < r.bottom + 40) sy = MAX * ramp(r.bottom - y);
    }
    if (inY) {
      if (x < r.left + T && x > r.left - 40) sx = -MAX * ramp(x - r.left);
      else if (x > r.right - T && x < r.right + 40) sx = MAX * ramp(r.right - x);
    }
    const carry = scrollCarry.current;
    carry.x += sx;
    carry.y += sy;
    const ix = Math.trunc(carry.x);
    const iy = Math.trunc(carry.y);
    if (iy) {
      el.scrollTop += iy;
      carry.y -= iy;
    }
    if (ix) {
      el.scrollLeft += ix;
      carry.x -= ix;
    }
    // Content moved under the pointer — retarget the drop.
    if ((ix || iy) && dragStart.current) updateTargetRef.current(x, y, dragStart.current.payload);
  }, [stopAutoScroll]);

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const moveDrag = (e: React.PointerEvent) => {
    const st = dragStart.current;
    if (!st) return;
    if (!ghost && Math.hypot(e.clientX - st.x, e.clientY - st.y) < 5) return;
    if (st.payload.kind === "slide") setDragging(st.payload.index);
    const p = st.payload;
    const carriesCells =
      p.kind === "media" ||
      (p.kind === "slide" && (slides[p.index]?.cells.length ?? 0) > 0) ||
      (p.kind === "member" && p.member.type === "cell");
    lastPoint.current = { x: e.clientX, y: e.clientY };
    if (autoScrollTimer.current === null) {
      scrollCarry.current = { x: 0, y: 0 };
      autoScrollTimer.current = window.setInterval(autoScrollTick, 16);
    }
    setGhost({ x: e.clientX, y: e.clientY, label: dragLabel(p), kind: p.kind, carriesCells });
    updateDragTarget(e.clientX, e.clientY, p);
  };

  const endDrag = () => {
    const st = dragStart.current;
    const wasDragging = ghost !== null;
    const zone = dropRef.current;
    const over = overRef.current;
    dragStart.current = null;
    stopAutoScroll();
    setGhost(null);
    setDragging(null);
    setDropBoth(null);
    setShelfHot(false);
    if (!st || !wasDragging) return; // a plain click — handled by onClick

    const p = st.payload;
    if (p.kind === "member") {
      if (zone?.kind === "band-member") reorderMember(p.member, zone.index);
      else splitMember(p.slide, p.member);
      return;
    }
    if (p.kind === "text") {
      if (zone?.kind === "bind") addTitle(zone.index);
      else if (zone?.kind === "band" && openIdx >= 0) addTitle(openIdx);
      return;
    }
    if (zone?.kind === "band" && openIdx >= 0) {
      if (p.kind === "slide") bind(openIdx, p.index);
      else bindMedia(openIdx, p.path);
      return;
    }
    if (p.kind === "slide") {
      if (over.shelf) removeSlide(p.index);
      else if (zone?.kind === "bind") bind(zone.index, p.index);
      else if (zone?.kind === "insert") reorder(p.index, zone.index);
      else if (over.grid) reorder(p.index, slides.length);
      return;
    }
    // media from the shelf
    if (zone?.kind === "bind") {
      bindMedia(zone.index, p.path);
      return;
    }
    if (zone?.kind === "insert" || over.grid) {
      const m = thumbs.get(p.path);
      const fresh = m ? slideForShelfItem(m) : null;
      if (fresh) insertSlides(zone?.kind === "insert" ? zone.index : slides.length, [fresh]);
    }
  };

  // ---- keyboard: navigate, reorder, open, split ----
  const gridKeys = (e: React.KeyboardEvent) => {
    const step =
      e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -cols : e.key === "ArrowDown" ? cols : 0;
    if (step !== 0) {
      e.preventDefault();
      const to = Math.max(0, Math.min(selected + step, slides.length - 1));
      if (e.altKey) {
        move(selected, selected + step);
      } else if (e.shiftKey || e.metaKey || e.ctrlKey) {
        // Extend the selection from the anchor (⇧ or ⌘ + arrows).
        const a = shiftAnchor.current ?? selected;
        shiftAnchor.current = a;
        setSelection(rangeIds(a, to), to);
        focusCard(to);
      } else {
        shiftAnchor.current = to;
        selectSlide(to);
        focusCard(to);
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicate(selected);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const s = slides[selected];
      if (s && membersOf(s).length > 1) {
        setOpenGroupId((id) => (id === s.id ? null : s.id));
        setMemberFocus(0);
      }
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      if (selectedIdxs.length > 1) {
        hideSlides(selectedIdxs);
      } else if (slides[selected]) {
        removeSlide(selected);
        focusCard(Math.max(0, Math.min(selected, slides.length - 2)));
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      if (selectedIdxs.length > 1) mergeSlides(selectedIdxs);
    } else if (e.key === "Escape") {
      if (selectedIdxs.length > 1) selectSlide(selected, false);
      else setOpenGroupId(null);
    }
  };

  const bandKeys = (e: React.KeyboardEvent) => {
    if (!openGroup) return;
    const members = membersOf(openGroup);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = e.key === "ArrowLeft" ? -1 : 1;
      setMemberFocus((f) => Math.max(0, Math.min(f + d, members.length - 1)));
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      if (members[memberFocus]) splitMember(openIdx, members[memberFocus]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpenGroupId(null);
      cardRefs.current.get(openIdx)?.focus();
    }
    e.stopPropagation();
  };

  // Focus rides selection while the user works inside the grid.
  useEffect(() => {
    const grid = gridRef.current;
    if (grid && grid.contains(document.activeElement)) {
      cardRefs.current.get(selected)?.focus();
    }
  }, [selected]);

  // The band keeps its group's row in view as the grid reflows.
  useEffect(() => {
    if (openGroup) {
      requestAnimationFrame(() => {
        cardRefs.current.get(openIdx)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      bandRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openGroupId]);

  // ---- render ----
  const bandAt = openGroup ? Math.min((Math.floor(openIdx / cols) + 1) * cols, slides.length) : -1;

  const bandHot = drop?.kind === "band" || drop?.kind === "band-member";
  const band = openGroup && (
    <div
      key="band"
      className={`group-band ${bandHot ? "receiving" : ""}`}
      ref={bandRef}
      tabIndex={0}
      role="group"
      aria-label={`Group of ${membersOf(openGroup).length} — arrow keys walk members, delete splits one out, escape closes`}
      onKeyDown={bandKeys}
    >
      <div className="band-members">
        {membersOf(openGroup).map((m, j) => {
          const text = m.type === "text" ? openGroup.texts[m.index] : undefined;
          const thumb = m.type === "cell" ? cellThumb(openGroup.cells[m.index], thumbs) : null;
          return (
            <div
              key={`${m.type}-${m.index}`}
              data-mi={j}
              className={`band-member ${m.type === "text" ? "band-text" : ""} ${j === memberFocus ? "focused" : ""} ${drop?.kind === "band-member" && drop.index === j ? "reorder-target" : ""}`}
              onPointerDown={(e) => beginDrag(e, { kind: "member", slide: openIdx, member: m })}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onClick={() => {
                setMemberFocus(j);
                if (m.type === "text") {
                  // A title member opens straight into its editor.
                  selectSlide(openIdx, false);
                  selectText(m.index);
                }
              }}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: "Split into its own slide", onPick: () => splitMember(openIdx, m) },
                ])
              }
            >
              {m.type === "text" ? (
                <span className="band-text-body" style={{ fontStyle: text?.italic ? "italic" : "normal" }}>
                  <span className="band-text-mark">T</span>
                  {text?.text.trim() ? text.text : text?.role}
                </span>
              ) : thumb ? (
                <img src={thumb} alt="" draggable={false} />
              ) : (
                <span className="thumb-empty" />
              )}
              <button
                className="member-remove"
                title="Split into its own slide after this group"
                onClick={(e) => {
                  e.stopPropagation();
                  splitMember(openIdx, m);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      <button className="ghost band-close" title="Close (Esc)" onClick={() => setOpenGroupId(null)}>
        Close
      </button>
    </div>
  );

  const cards = slides.map((s, i) => {
    const isReceiving = drop?.kind === "bind" && drop.index === i;
    const insertBefore = drop?.kind === "insert" && drop.index === i;
    const insertAfter = drop?.kind === "insert" && drop.index === i + 1;
    const proportional = mode === "time";
    // In the vertical strip the card is (panel − ruler − lane − padding) wide
    // and duration tall; the thumb's rect math needs that real box shape.
    const cardAspect = !proportional
      ? aspect
      : vertical
        ? Math.max(panelW - 84, 60) / Math.max(widths[i] - 8, 24)
        : Math.max(widths[i] - 8, 24) / TIME_THUMB_H;
    const firstText = s.texts.find((t) => t.text.trim());
    return (
      <div
        key={s.id}
        ref={(el) => {
          if (el) cardRefs.current.set(i, el);
          else cardRefs.current.delete(i);
        }}
        className={[
          "slide-card",
          selectedIds.includes(s.id) ? "selected" : "",
          i === selected ? "anchor" : "",
          isReceiving ? "receiving" : "",
          insertBefore ? "insert-before" : "",
          insertAfter ? "insert-after" : "",
          dragging === i ? "dragging" : "",
          proportional ? "proportional" : "",
        ].join(" ")}
        style={proportional ? (vertical ? { height: widths[i] } : { width: widths[i] }) : undefined}
        tabIndex={i === selected ? 0 : -1}
        role="option"
        aria-selected={i === selected}
        aria-label={`Slide ${i + 1} of ${slides.length}${membersOf(s).length > 1 ? `, group of ${membersOf(s).length}` : ""}${proportional ? `, ${s.duration.toFixed(1)} seconds` : ""}`}
        data-index={i}
        onPointerDown={(e) => beginDrag(e, { kind: "slide", index: i })}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onClick={(e) => clickCard(e, i)}
        onContextMenu={(e) => cardMenu(e, i)}
        onDoubleClick={() => {
          if (mode === "arrange" && membersOf(s).length > 1) {
            setOpenGroupId(s.id);
            setMemberFocus(0);
          }
        }}
      >
        <SlideThumb
          slide={s}
          thumbs={thumbs}
          aspect={cardAspect}
          receiving={isReceiving && ghost?.carriesCells === true}
          fill={proportional && vertical}
        />
        {membersOf(s).length > 1 && <span className="card-count">{membersOf(s).length}</span>}
        <span className="card-index">{i + 1}</span>
        {proportional && <span className="card-duration">{s.duration.toFixed(1)}s</span>}
        {proportional && firstText && (
          <button
            className="card-text-chip"
            title="Edit this text (opens it in the panel)"
            onClick={(e) => {
              e.stopPropagation();
              selectSlide(i, false);
              selectText(s.texts.indexOf(firstText));
            }}
          >
            T {firstText.text}
          </button>
        )}
      </div>
    );
  });

  const children: React.ReactNode[] = [...cards];
  if (band && bandAt >= 0) children.splice(bandAt, 0, band);

  const dockToggle = (
    <div className="dock-toggle" role="group" aria-label="Timeline position">
      {(["left", "bottom", "right", "split"] as const).map((d) => (
        <button
          key={d}
          className={dock === d ? "on" : ""}
          aria-pressed={dock === d}
          title={
            d === "split"
              ? "Split view: Arrange left, Time at the bottom"
              : `Dock timeline ${d === "bottom" ? "at the bottom" : `on the ${d}`}`
          }
          onClick={() => setUi({ dock: d })}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="0.5" y="0.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" />
            {d === "left" && <rect x="1.5" y="1.5" width="3.5" height="9" fill="currentColor" />}
            {d === "bottom" && <rect x="1.5" y="7" width="9" height="3.5" fill="currentColor" />}
            {d === "right" && <rect x="7" y="1.5" width="3.5" height="9" fill="currentColor" />}
            {d === "split" && (
              <>
                <rect x="1.5" y="1.5" width="3.5" height="5" fill="currentColor" />
                <rect x="1.5" y="7.5" width="9" height="3" fill="currentColor" />
              </>
            )}
          </svg>
        </button>
      ))}
    </div>
  );

  const collapseButton = face && (
    <button
      className="ghost"
      title={`Hide the ${face === "arrange" ? "Arrange" : "Time"} panel`}
      onClick={() =>
        setUi(face === "arrange" ? { arrangeCollapsed: true } : { timeCollapsed: true })
      }
    >
      —
    </button>
  );

  return (
    <footer className={`timeline ${mode} ${face ? `face-${face}` : ""}`}>
      <div className="timeline-bar">
        {face ? (
          <span className="panel-label">{face === "arrange" ? "Arrange" : "Time"}</span>
        ) : (
          <div className="mode-toggle" role="tablist" aria-label="Timeline mode">
            <button role="tab" aria-selected={mode === "arrange"} className={mode === "arrange" ? "on" : ""} onClick={() => switchMode("arrange")}>
              Arrange
            </button>
            <button role="tab" aria-selected={mode === "time"} className={mode === "time" ? "on" : ""} onClick={() => switchMode("time")}>
              Time
            </button>
          </div>
        )}
        {face !== "time" && (
          <span className="hint">
            {slides.length} slide{slides.length === 1 ? "" : "s"}
          </span>
        )}
        {face !== "time" && (
          <span
            className="title-chip"
            title="Drag onto a photo or group to put a title on it"
            onPointerDown={(e) => beginDrag(e, { kind: "text" })}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
          >
            T Title
          </span>
        )}
        {face === "time" ? (
          <div className="timeline-actions">{collapseButton}</div>
        ) : (
          <div className="timeline-actions">
            <button onClick={onImport}>+ Import</button>
            <button onClick={addEmpty}>+ Blank slide</button>
            <button
              onClick={() => duplicate(selected)}
              disabled={!slides[selected]}
              title="Duplicate the selected slide (⌘D)"
            >
              ⧉ Duplicate
            </button>
            <button
              className={`ghost ${shelfOpen ? "on" : ""}`}
              aria-expanded={shelfOpen}
              onClick={() => setShelfOpen(!shelfOpen)}
            >
              Not used ({unused.length})
            </button>
            {dockToggle}
            {collapseButton}
          </div>
        )}
      </div>

      {mode === "arrange" ? (
        <div
          ref={gridRef}
          className="arrange-grid"
          role="listbox"
          aria-label="Slides in playback order"
          onKeyDown={gridKeys}
        >
          {slides.length === 0 && (
            <p className="hint center empty-grid">
              Drop photos, clips and music anywhere — every photo becomes a slide.
            </p>
          )}
          {children}
        </div>
      ) : (
        <div
          ref={(el) => {
            gridRef.current = el;
            stripRef.current = el;
          }}
          className={`time-strip ${vertical ? "vertical" : ""}`}
          role="listbox"
          aria-label={`Slides on the clock — card ${vertical ? "height" : "width"} is duration`}
          onKeyDown={gridKeys}
        >
          <div
            className="time-content"
            style={vertical ? { height: contentW } : { width: contentW }}
          >
            <div
              className="time-ruler"
              onPointerDown={(e) => {
                setPlaying(false);
                seekAt(e);
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // Synthetic pointers have no capturable id.
                }
              }}
              onPointerMove={(e) => {
                if (e.buttons & 1) seekAt(e);
              }}
            >
              {Array.from({ length: Math.floor(total / 10) + 1 }, (_, k) => (
                <span
                  key={k}
                  className="ruler-tick"
                  style={vertical ? { top: k * 10 * PX_PER_SEC } : { left: k * 10 * PX_PER_SEC }}
                >
                  {fmtClock(k * 10)}
                </span>
              ))}
            </div>
            <div className="time-row">{cards}</div>
            <div className="audio-lane">
              <canvas
                ref={laneRef}
                aria-label="Music waveform"
                style={vertical ? { height: contentW } : { width: contentW }}
              />
              {!hasMix && !vertical && (
                <span className="hint lane-hint">No music yet — add a track from “Not used”.</span>
              )}
            </div>
            {slides.map(
              (s, i) =>
                s.transition.kind.type !== "cut" && (
                  <button
                    key={`seam-${s.id}`}
                    className="seam-marker"
                    style={vertical ? { top: lefts[i] } : { left: lefts[i] }}
                    title={`${i === 0 ? "Opens with" : TRANSITION_NAMES[s.transition.kind.type] ?? "Transition"}${i === 0 ? ` (${TRANSITION_NAMES[s.transition.kind.type]?.toLowerCase() ?? "fade"})` : ""} · ${s.transition.duration.toFixed(1)}s`}
                    onClick={() => selectSlide(i)}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                      <path d="M5 0 L10 5 L5 10 L0 5 Z" fill="currentColor" />
                    </svg>
                  </button>
                ),
            )}
            {project.outro.kind.type !== "cut" && total > 0 && (
              <button
                className="seam-marker"
                style={vertical ? { top: total * PX_PER_SEC } : { left: total * PX_PER_SEC }}
                title={`Ends with ${TRANSITION_NAMES[project.outro.kind.type]?.toLowerCase() ?? "a fade"} · ${project.outro.duration.toFixed(1)}s`}
                onClick={() => selectSlide(slides.length - 1)}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M5 0 L10 5 L5 10 L0 5 Z" fill="currentColor" />
                </svg>
              </button>
            )}
            <div
              className="playhead"
              style={vertical ? { top: time * PX_PER_SEC } : { left: time * PX_PER_SEC }}
              aria-hidden="true"
            />
          </div>
        </div>
      )}

      {face !== "time" && shelfOpen && unused.length > 0 && (
        <div className={`shelf ${shelfHot ? "drop-hot" : ""}`} aria-label="Not used">
          {unused.map((m) => (
            <div
              key={m.path}
              className="shelf-item"
              title={m.path}
              onPointerDown={(e) => {
                if (m.status === "ready") beginDrag(e, { kind: "media", path: m.path });
              }}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onContextMenu={(e) => shelfMenu(e, m)}
            >
              {m.status === "ready" && m.thumb ? (
                <img src={m.thumb} alt="" draggable={false} />
              ) : (
                <span className="thumb-empty">
                  {m.status === "pending" ? "⋯" : m.status === "error" ? "!" : "♫"}
                </span>
              )}
              <span className="shelf-name">{m.path.replace(/^.*[/\\]/, "")}</span>
              {m.status === "ready" && (m.info.is_image || m.info.has_video) && (
                <button
                  title="Add to the timeline as a slide"
                  onClick={() => insertSlides(slides.length, [slideForMedia(m)])}
                >
                  + Slide
                </button>
              )}
              {m.status === "ready" && m.info.has_audio && !m.info.has_video && (
                <button
                  title="Add as a music track"
                  onClick={() => mutate((p) => ({ ...p, audio: [...p.audio, audioTrackFor(m)] }))}
                >
                  + Music
                </button>
              )}
              <button className="ghost" title="Remove from the project" onClick={() => removeMedia(m.path)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {ghost && (
        <div className="drag-ghost" style={{ left: ghost.x + 14, top: ghost.y + 12 }} aria-hidden="true">
          {ghost.label}
        </div>
      )}

      {menu && (
        <div
          className="context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menu.entries.map((entry, k) =>
            entry === "sep" ? (
              <div key={k} className="menu-sep" role="separator" />
            ) : (
              <button
                key={k}
                role="menuitem"
                disabled={entry.disabled}
                onClick={() => {
                  setMenu(null);
                  entry.onPick();
                }}
              >
                {entry.label}
              </button>
            ),
          )}
        </div>
      )}
    </footer>
  );
}
