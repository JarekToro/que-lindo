import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { layoutRects } from "../layout";
import { ensureAudioCtx, mixForRev } from "../mixcache";
import {
  audioTrackFor,
  autoLayout,
  bindSlides,
  defaultSlide,
  dissolveGroup,
  freshId,
  GROUP_MAX,
  slideForCell,
  slideForMedia,
} from "../presets";
import { useEditor } from "../store";
import type { Cell, MediaInfo, MediaItem, Slide } from "../types";

/**
 * The timeline — the mode-carrying surface under the frame. Arrange is a
 * wrapping grid of equal-width slide cards in playback order: drag or use the
 * keyboard to reorder, drop a card onto another to bind them into one slide,
 * press ↵ on a group to open it as a full-width band. Time (groundwork for
 * the proportional view) stretches the same cards to their durations.
 */

const SLIDE_MIME = "application/x-slide-index";
const MEDIA_MIME = "application/x-media-path";
const MEMBER_MIME = "application/x-group-member";

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

/** Min/max peaks of the mix drawn into the lane canvas. */
function drawWaveform(canvas: HTMLCanvasElement, buffer: AudioBuffer | null, cssWidth: number) {
  const w = Math.max(1, Math.min(Math.round(cssWidth), 8192));
  const h = 56;
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, w, h);
  if (!buffer) return;
  const data = buffer.getChannelData(0);
  const step = data.length / w;
  g.fillStyle = "rgba(212, 175, 110, 0.55)";
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    let min = 0;
    let max = 0;
    const from = Math.floor(x * step);
    const to = Math.min(Math.floor((x + 1) * step), data.length);
    for (let i = from; i < to; i += 4) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const top = mid + min * mid;
    const bottom = mid + max * mid;
    g.fillRect(x, top, 1, Math.max(bottom - top, 1));
  }
}

type DropZone = { kind: "bind"; index: number } | { kind: "insert"; index: number };

function zoneForCard(e: React.DragEvent, index: number, el: HTMLElement): DropZone {
  const r = el.getBoundingClientRect();
  const frac = (e.clientX - r.left) / Math.max(r.width, 1);
  if (frac < 0.25) return { kind: "insert", index };
  if (frac > 0.75) return { kind: "insert", index: index + 1 };
  return { kind: "bind", index };
}

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
}: {
  slide: Slide;
  thumbs: Map<string, MediaItem>;
  aspect: number;
  receiving?: boolean;
}) {
  const n = slide.cells.length + (receiving ? 1 : 0);
  const layout = receiving ? autoLayout(n) : slide.layout;
  const W = 160;
  const H = W / aspect;
  const margin = receiving ? 0.04 : slide.margin;
  const rects = layoutRects(layout, n, W, H, margin, slide.gutter);
  const title = slide.texts.find((t) => t.text.trim());

  return (
    <div className="slide-thumb" style={{ aspectRatio: `${aspect}` }}>
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
      {slide.cells.length === 0 && title && <span className="thumb-title">{title.text}</span>}
    </div>
  );
}

export default function Timeline({ onImport }: { onImport: () => void }) {
  const project = useEditor((s) => s.project);
  const selected = useEditor((s) => s.selectedSlide);
  const selectSlide = useEditor((s) => s.selectSlide);
  const selectText = useEditor((s) => s.selectText);
  const mutate = useEditor((s) => s.mutate);
  const media = useEditor((s) => s.media);
  const removeMedia = useEditor((s) => s.removeMedia);
  const mode = useEditor((s) => s.mode);
  const setMode = useEditor((s) => s.setMode);
  const timing = useEditor((s) => s.timing);
  const time = useEditor((s) => s.time);
  const setTime = useEditor((s) => s.setTime);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const rev = useEditor((s) => s.rev);
  const thumbs = useThumbs();

  const slides = project.slides;
  const aspect = project.settings.width / Math.max(project.settings.height, 1);

  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const [memberFocus, setMemberFocus] = useState(0);
  const [drop, setDrop] = useState<DropZone | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [shelfOpen, setShelfOpen] = useState(true);
  const [cols, setCols] = useState(6);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const bandRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<number, HTMLDivElement>());

  // ---- derived group/band state ----
  const openIdx = openGroupId === null ? -1 : slides.findIndex((s) => s.id === openGroupId);
  const openGroup = openIdx >= 0 && slides[openIdx].cells.length > 1 ? slides[openIdx] : null;
  useEffect(() => {
    // The group left the timeline or dissolved — the band follows it out.
    if (openGroupId !== null && !openGroup) setOpenGroupId(null);
  }, [openGroupId, openGroup]);

  // ---- columns: measured, so the band lands after the group's real row ----
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
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
        if (laneRef.current) drawWaveform(laneRef.current, buffer, contentW);
      })
      .catch(() => setHasMix(false));
    return () => {
      dead = true;
    };
  }, [mode, rev, contentW]);

  // Scrubbing on the ruler: proportional position is the playhead.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const seekAt = useCallback(
    (e: React.PointerEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setTime(Math.max(0, (e.clientX - rect.left) / PX_PER_SEC));
    },
    [setTime],
  );

  // Playback keeps the playhead in view.
  useEffect(() => {
    if (mode !== "time" || !playing) return;
    const strip = stripRef.current;
    if (!strip) return;
    const x = time * PX_PER_SEC;
    if (x < strip.scrollLeft + 40 || x > strip.scrollLeft + strip.clientWidth - 80) {
      strip.scrollLeft = Math.max(0, x - strip.clientWidth * 0.3);
    }
  }, [time, playing, mode]);

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

  /** Bind: source slide's photos join the target slide. */
  const bind = (targetIdx: number, sourceIdx: number) => {
    if (targetIdx === sourceIdx) return;
    const target = slides[targetIdx];
    const source = slides[sourceIdx];
    if (target.cells.length + source.cells.length > GROUP_MAX || source.cells.length === 0) return;
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

  /** Split one member out — it re-enters the timeline as its own slide
   * directly after the group. Down to one member, the group dissolves. */
  const splitMember = (slideIdx: number, cellIdx: number) => {
    const group = slides[slideIdx];
    if (group.cells.length < 2) return;
    const cell = group.cells[cellIdx];
    const rest = group.cells.filter((_, i) => i !== cellIdx);
    mutate((p) => {
      let remaining: Slide = {
        ...group,
        cells: rest,
        layout: autoLayout(rest.length),
      };
      if (rest.length === 1) remaining = dissolveGroup(remaining, cellInfo(rest[0], thumbs));
      const lifted = slideForCell(cell, cellInfo(cell, thumbs));
      const next = [...p.slides];
      next.splice(slideIdx, 1, remaining, lifted);
      return { ...p, slides: next };
    });
    setMemberFocus((f) => Math.max(0, Math.min(f, rest.length - 1)));
  };

  const addEmpty = () => insertSlides(slides.length, [defaultSlide()]);

  const slideForShelfItem = (m: MediaItem): Slide | null =>
    m.status === "ready" && (m.info.is_image || m.info.has_video) ? slideForMedia(m) : null;

  // ---- drag handling ----
  const handleCardDragOver = (e: React.DragEvent, i: number) => {
    const types = e.dataTransfer.types;
    if (!types.includes(SLIDE_MIME) && !types.includes(MEDIA_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    const zone = zoneForCard(e, i, e.currentTarget as HTMLElement);
    // A bind that would overfill the group falls back to inserting beside.
    if (zone.kind === "bind") {
      const room = slides[i].cells.length < GROUP_MAX && dragging !== i;
      if (!room) {
        setDrop({ kind: "insert", index: i + 1 });
        return;
      }
    }
    setDrop(zone);
  };

  const handleGridDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const zone = drop;
    setDrop(null);
    setDragging(null);
    const slideIdx = e.dataTransfer.getData(SLIDE_MIME);
    const mediaPath = e.dataTransfer.getData(MEDIA_MIME);
    const member = e.dataTransfer.getData(MEMBER_MIME);
    if (member) {
      const parsed: unknown = JSON.parse(member);
      if (parsed && typeof parsed === "object" && "slide" in parsed && "cell" in parsed) {
        const at = parsed as { slide: number; cell: number };
        splitMember(at.slide, at.cell);
      }
      return;
    }
    if (slideIdx !== "") {
      const from = parseInt(slideIdx, 10);
      if (zone?.kind === "bind") bind(zone.index, from);
      else if (zone?.kind === "insert") reorder(from, zone.index);
      else reorder(from, slides.length);
      return;
    }
    if (mediaPath) {
      if (zone?.kind === "bind") {
        bindMedia(zone.index, mediaPath);
        return;
      }
      const m = thumbs.get(mediaPath);
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
      if (e.altKey) {
        move(selected, selected + step);
      } else {
        const to = Math.max(0, Math.min(selected + step, slides.length - 1));
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
      if (s && s.cells.length > 1) {
        setOpenGroupId((id) => (id === s.id ? null : s.id));
        setMemberFocus(0);
      }
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      if (slides[selected]) {
        removeSlide(selected);
        focusCard(Math.max(0, Math.min(selected, slides.length - 2)));
      }
    } else if (e.key === "Escape") {
      setOpenGroupId(null);
    }
  };

  const bandKeys = (e: React.KeyboardEvent) => {
    if (!openGroup) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = e.key === "ArrowLeft" ? -1 : 1;
      setMemberFocus((f) => Math.max(0, Math.min(f + d, openGroup.cells.length - 1)));
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      splitMember(openIdx, memberFocus);
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

  const band = openGroup && (
    <div
      key="band"
      className="group-band"
      ref={bandRef}
      tabIndex={0}
      role="group"
      aria-label={`Group of ${openGroup.cells.length} — arrow keys walk members, delete splits one out, escape closes`}
      onKeyDown={bandKeys}
    >
      <div className="band-members">
        {openGroup.cells.map((cell, j) => {
          const thumb = cellThumb(cell, thumbs);
          return (
            <div
              key={j}
              className={`band-member ${j === memberFocus ? "focused" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(MEMBER_MIME, JSON.stringify({ slide: openIdx, cell: j }));
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => setMemberFocus(j)}
            >
              {thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="thumb-empty" />}
              <button
                className="member-remove"
                title="Split into its own slide after this group"
                onClick={(e) => {
                  e.stopPropagation();
                  splitMember(openIdx, j);
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
    const cardAspect = proportional ? Math.max(widths[i] - 8, 24) / TIME_THUMB_H : aspect;
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
          i === selected ? "selected" : "",
          isReceiving ? "receiving" : "",
          insertBefore ? "insert-before" : "",
          insertAfter ? "insert-after" : "",
          dragging === i ? "dragging" : "",
          proportional ? "proportional" : "",
        ].join(" ")}
        style={proportional ? { width: widths[i] } : undefined}
        tabIndex={i === selected ? 0 : -1}
        role="option"
        aria-selected={i === selected}
        aria-label={`Slide ${i + 1} of ${slides.length}${s.cells.length > 1 ? `, group of ${s.cells.length}` : ""}${proportional ? `, ${s.duration.toFixed(1)} seconds` : ""}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(SLIDE_MIME, String(i));
          e.dataTransfer.effectAllowed = "move";
          setDragging(i);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDrop(null);
        }}
        onDragOver={(e) => handleCardDragOver(e, i)}
        onDragLeave={() => setDrop((d) => (d?.kind === "bind" && d.index === i ? null : d))}
        onClick={() => selectSlide(i)}
        onDoubleClick={() => {
          if (mode === "arrange" && s.cells.length > 1) {
            setOpenGroupId(s.id);
            setMemberFocus(0);
          }
        }}
      >
        <SlideThumb slide={s} thumbs={thumbs} aspect={cardAspect} receiving={isReceiving} />
        {s.cells.length > 1 && <span className="card-count">{s.cells.length}</span>}
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

  return (
    <footer className={`timeline ${mode}`}>
      <div className="timeline-bar">
        <div className="mode-toggle" role="tablist" aria-label="Timeline mode">
          <button role="tab" aria-selected={mode === "arrange"} className={mode === "arrange" ? "on" : ""} onClick={() => switchMode("arrange")}>
            Arrange
          </button>
          <button role="tab" aria-selected={mode === "time"} className={mode === "time" ? "on" : ""} onClick={() => switchMode("time")}>
            Time
          </button>
        </div>
        <span className="hint">
          {slides.length} slide{slides.length === 1 ? "" : "s"}
        </span>
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
        </div>
      </div>

      {mode === "arrange" ? (
        <div
          ref={gridRef}
          className="arrange-grid"
          role="listbox"
          aria-label="Slides in playback order"
          onKeyDown={gridKeys}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(SLIDE_MIME) || e.dataTransfer.types.includes(MEDIA_MIME) || e.dataTransfer.types.includes(MEMBER_MIME))
              e.preventDefault();
          }}
          onDrop={handleGridDrop}
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
          className="time-strip"
          role="listbox"
          aria-label="Slides on the clock — card width is duration"
          onKeyDown={gridKeys}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(SLIDE_MIME) || e.dataTransfer.types.includes(MEDIA_MIME))
              e.preventDefault();
          }}
          onDrop={handleGridDrop}
        >
          <div className="time-content" style={{ width: contentW }}>
            <div
              className="time-ruler"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setPlaying(false);
                seekAt(e);
              }}
              onPointerMove={(e) => {
                if (e.buttons & 1) seekAt(e);
              }}
            >
              {Array.from({ length: Math.floor(total / 10) + 1 }, (_, k) => (
                <span key={k} className="ruler-tick" style={{ left: k * 10 * PX_PER_SEC }}>
                  {fmtClock(k * 10)}
                </span>
              ))}
            </div>
            <div className="time-row">{cards}</div>
            <div className="audio-lane">
              <canvas ref={laneRef} aria-label="Music waveform" style={{ width: contentW }} />
              {!hasMix && (
                <span className="hint lane-hint">No music yet — add a track from “Not used”.</span>
              )}
            </div>
            {slides.map(
              (s, i) =>
                i > 0 &&
                s.transition.kind.type !== "cut" && (
                  <button
                    key={`seam-${s.id}`}
                    className="seam-marker"
                    style={{ left: lefts[i] }}
                    title={`${TRANSITION_NAMES[s.transition.kind.type] ?? "Transition"} · ${s.transition.duration.toFixed(1)}s`}
                    onClick={() => selectSlide(i)}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                      <path d="M5 0 L10 5 L5 10 L0 5 Z" fill="currentColor" />
                    </svg>
                  </button>
                ),
            )}
            <div className="playhead" style={{ left: time * PX_PER_SEC }} aria-hidden="true" />
          </div>
        </div>
      )}

      {shelfOpen && unused.length > 0 && (
        <div
          className="shelf"
          aria-label="Not used"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(SLIDE_MIME)) e.preventDefault();
          }}
          onDrop={(e) => {
            const idx = e.dataTransfer.getData(SLIDE_MIME);
            if (idx !== "") {
              e.preventDefault();
              e.stopPropagation();
              removeSlide(parseInt(idx, 10));
            }
          }}
        >
          {unused.map((m) => (
            <div
              key={m.path}
              className="shelf-item"
              title={m.path}
              draggable={m.status === "ready"}
              onDragStart={(e) => e.dataTransfer.setData(MEDIA_MIME, m.path)}
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
    </footer>
  );
}
