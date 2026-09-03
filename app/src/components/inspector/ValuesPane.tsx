// The three flat selection scopes plus the pinned member strip. One control
// per fact: sliders with typeable readouts for anything numeric, verb rows
// only for style picks that have no natural number. Nothing folds away.

import { useState } from "react";
import { detectFocus } from "../../api";
import {
  activeScatterVariant,
  scatterState,
  scatterVariantPatch,
  scatterVariants,
  smartScatterPatch,
} from "../../layouts";
import { layoutRects } from "../../layout";
import { defaultText, lowerThird } from "../../presets";
import { useEditor } from "../../store";
import type { Cell, Slide, TextOverlay, TransitionKind } from "../../types";
import { kindLabel, MOTIONS, motionLabel } from "./data";
import FontPicker from "./FontPicker";
import LayoutPicker, { cellFills, layoutTileSize, TileCell } from "./LayoutPicker";
import {
  AnchorGrid,
  ColorField,
  EchoRow,
  NumField,
  Segmented,
  SegmentedToggles,
  SliderField,
  Verbs,
  VGroup,
} from "./fields";

function cellName(c: Cell): string {
  return c.source.type === "solid" ? "color" : c.source.path.replace(/^.*[/\\]/, "");
}

/** The navigator: slide chip, member chips, add menu. Always visible; the
 * slide chip is the way back from any member. */
export function MemberStrip({
  slide,
  index,
  thumbFor,
}: {
  slide: Slide;
  index: number;
  thumbFor: (c: Cell) => string | null;
}) {
  const selectedCell = useEditor((s) => s.selectedCell);
  const selectedText = useEditor((s) => s.selectedText);
  const selectCell = useEditor((s) => s.selectCell);
  const selectText = useEditor((s) => s.selectText);
  const updateSlide = useEditor((s) => s.updateSlide);

  const onSlide = selectedCell === null && selectedText === null;
  const toSlide = () => {
    selectCell(null);
    selectText(null);
  };

  const addText = (kind: "title" | "caption" | "lower") => {
    if (kind === "lower") {
      // Placeholders, not blocking prompts — edit in the panel after.
      updateSlide(index, { texts: [...slide.texts, ...lowerThird("Name", "Dates")] });
      selectText(slide.texts.length);
      return;
    }
    const text =
      kind === "title"
        ? defaultText({ text: "Title", role: "title", size: 0.08, anchor: "center", offset: [0, 0], fade: 0.6 })
        : defaultText({ text: "Caption", role: "caption" });
    updateSlide(index, { texts: [...slide.texts, text] });
    selectText(slide.texts.length);
  };

  return (
    <div className="member-strip pinned">
      <span className={`member-chip slide ${onSlide ? "on" : ""}`}>
        <button className="chip-body" title="Slide settings" onClick={toSlide}>
          <span className="chip-label">Slide {index + 1}</span>
        </button>
      </span>
      {slide.cells.map((c, ci) => {
        const thumb = thumbFor(c);
        return (
          <span key={`c${ci}`} className={`member-chip ${selectedCell === ci ? "on" : ""}`}>
            <button className="chip-body" title={cellName(c)} onClick={() => selectCell(ci)}>
              {thumb ? <img src={thumb} alt="" /> : <span className="thumb-empty">▤</span>}
            </button>
            <button
              className="chip-x"
              title="Remove from this slide"
              onClick={() =>
                updateSlide(index, { cells: slide.cells.filter((_, i) => i !== ci) })
              }
            >
              ✕
            </button>
          </span>
        );
      })}
      {slide.texts.map((t, ti) => (
        <span key={`t${ti}`} className={`member-chip text ${selectedText === ti ? "on" : ""}`}>
          <button className="chip-body" title={t.text || t.role} onClick={() => selectText(ti)}>
            <span className="chip-t">T</span>
            <span className="chip-label">{t.text.trim() ? t.text : t.role}</span>
          </button>
          <button
            className="chip-x"
            title="Remove this text"
            onClick={() => updateSlide(index, { texts: slide.texts.filter((_, i) => i !== ti) })}
          >
            ✕
          </button>
        </span>
      ))}
      <div className="menu">
        <button className="chip-add" title="Add text to this slide">
          +
        </button>
        <div className="menu-items">
          <button onClick={() => addText("title")}>Title</button>
          <button onClick={() => addText("caption")}>Caption</button>
          <button onClick={() => addText("lower")}>Lower third</button>
        </div>
      </div>
    </div>
  );
}

/** Scatter's own controls, shown while the slide is on a pile: the variant
 * tiles are the manual choice, and Auto is an action — one press finds the
 * pile and deal that keep detected faces uncovered, then it's done. */
function ScatterRow({ slide, index }: { slide: Slide; index: number }) {
  const media = useEditor((s) => s.media);
  const updateSlide = useEditor((s) => s.updateSlide);
  const settings = useEditor((s) => s.project.settings);
  if (scatterState(slide) === "off") return null;
  const variants = scatterVariants(slide.cells.length);
  const active = activeScatterVariant(slide);
  const { w: tw, h: th } = layoutTileSize(settings.width / Math.max(1, settings.height));
  const fills = cellFills(slide, media);
  return (
    <div className="vrow">
      <span className="vlabel">Pile</span>
      <span className="variant-row" role="group" aria-label="Pile">
        <button
          className="pile-auto"
          title="Find the pile and arrangement that keep detected faces uncovered"
          onClick={() => {
            const patch = smartScatterPatch(slide, media);
            if (patch) updateSlide(index, patch);
          }}
        >
          Auto
        </button>
        {variants.map((v, vi) => (
          <button
            key={vi}
            className={`layout-tile ${vi === active ? "on" : ""}`}
            style={{ width: tw, height: th }}
            title={`Pile ${v.label}`}
            aria-label={`Pile ${v.label}`}
            aria-pressed={vi === active}
            onClick={() => {
              const patch = scatterVariantPatch(slide, vi);
              if (patch) updateSlide(index, patch);
            }}
          >
            {layoutRects({ type: "custom", rects: v.rects }, slide.cells.length, tw, th, 0, 0.03).map(
              (r, ci) => (
                <TileCell
                  key={ci}
                  r={r}
                  fill={fills[ci] ?? null}
                  rotation={v.angles[ci % v.angles.length]}
                />
              ),
            )}
          </button>
        ))}
      </span>
    </div>
  );
}

export function SlideValues({ slide, index }: { slide: Slide; index: number }) {
  const project = useEditor((s) => s.project);
  const updateSlide = useEditor((s) => s.updateSlide);
  const mutate = useEditor((s) => s.mutate);

  const kind = slide.transition.kind;
  const directional = kind.type === "slide" || kind.type === "wipe";
  const bg = slide.background;
  const isLast = index === project.slides.length - 1;

  const setKind = (k: TransitionKind) =>
    updateSlide(index, { transition: { ...slide.transition, kind: k } });
  const kindVerbs: { label: string; active: boolean; kind: TransitionKind }[] = [
    { label: "Cut", active: kind.type === "cut", kind: { type: "cut" } },
    { label: "Fade", active: kind.type === "cross_fade", kind: { type: "cross_fade" } },
    {
      label: "Black",
      active: kind.type === "fade_black" || kind.type === "fade_white",
      kind: { type: "fade_black" },
    },
    { label: "Slide", active: kind.type === "slide", kind: { type: "slide", dir: "left" } },
    { label: "Wipe", active: kind.type === "wipe", kind: { type: "wipe", dir: "left" } },
  ];

  return (
    <>
      <VGroup label="Timing">
        <SliderField label="On screen" value={slide.duration} min={0.5} max={20} step={0.1} typeMax={120} display="s"
          onChange={(v) => updateSlide(index, { duration: Math.max(0.5, v) })} />
      </VGroup>
      <VGroup label="Arrangement">
        {slide.cells.length > 1 && <LayoutPicker slide={slide} index={index} />}
        {slide.cells.length > 1 && <ScatterRow slide={slide} index={index} />}
        <SliderField label="Margin" value={slide.margin} min={0} max={0.2} step={0.01} display="pct"
          onChange={(v) => updateSlide(index, { margin: v })} />
        <SliderField label="Gutter" value={slide.gutter} min={0} max={0.1} step={0.005} display="pct"
          onChange={(v) => updateSlide(index, { gutter: v })} />
      </VGroup>
      <VGroup label="Background">
        <label className="vrow">
          <span className="vlabel">Fill</span>
          <select
            value={slide.background.type}
            onChange={(e) => {
              const v = e.target.value;
              updateSlide(index, {
                background:
                  v === "color"
                    ? { type: "color", color: "#000000" }
                    : v === "blur"
                      ? { type: "blur", cell: 0, sigma: 0.02, dim: 0.35 }
                      : { type: "default" },
              });
            }}
          >
            <option value="default">Project color</option>
            <option value="color">Custom color</option>
            <option value="blur">Blurred media</option>
          </select>
        </label>
        {bg.type === "color" && (
          <ColorField label="Color" value={bg.color}
            onChange={(color) => updateSlide(index, { background: { type: "color", color } })} />
        )}
        {bg.type === "blur" && (
          <>
            <SliderField label="Blur" value={bg.sigma} min={0} max={0.1} step={0.005} display="pct"
              onChange={(sigma) => updateSlide(index, { background: { ...bg, sigma } })} />
            <SliderField label="Dim" value={bg.dim} min={0} max={1} step={0.05} display="pct"
              onChange={(dim) => updateSlide(index, { background: { ...bg, dim } })} />
          </>
        )}
      </VGroup>
      <VGroup label={index === 0 ? "Opens with" : "Arrives by"}>
        <Verbs
          label={kindLabel(kind)}
          options={kindVerbs.map((v) => ({
            label: v.label,
            active: v.active,
            onPick: () => setKind(v.kind),
          }))}
        />
        {directional && (
          <Segmented
            label="Direction"
            options={[
              { label: "←", value: "left", title: "From the right, moving left" },
              { label: "→", value: "right", title: "From the left, moving right" },
              { label: "↑", value: "up", title: "Upward" },
              { label: "↓", value: "down", title: "Downward" },
            ]}
            value={kind.type === "slide" || kind.type === "wipe" ? kind.dir : "left"}
            onChange={(dir) =>
              updateSlide(index, {
                transition: { ...slide.transition, kind: { type: kind.type as "slide" | "wipe", dir } },
              })
            }
          />
        )}
        <SliderField label="Time" value={slide.transition.duration} min={0} max={5} step={0.1} display="s"
          onChange={(v) => updateSlide(index, { transition: { ...slide.transition, duration: v } })} />
      </VGroup>
      {isLast && (
        <VGroup label="Ends with">
          <Verbs
            label={kindLabel(project.outro.kind)}
            options={(
              [
                ["Cut", { type: "cut" }],
                ["Fade", { type: "cross_fade" }],
                ["Black", { type: "fade_black" }],
                ["Slide", { type: "slide", dir: "left" }],
                ["Wipe", { type: "wipe", dir: "left" }],
              ] as [string, TransitionKind][]
            ).map(([label, k]) => ({
              label,
              active: project.outro.kind.type === k.type,
              onPick: () =>
                mutate((p) => ({
                  ...p,
                  outro: {
                    kind: k,
                    duration:
                      k.type === "cut" ? 0 : p.outro.duration > 0.05 ? p.outro.duration : 1.5,
                  },
                })),
            }))}
          />
        </VGroup>
      )}
      <VGroup label="Label">
        <label className="vrow">
          <span className="vlabel">Label</span>
          <input value={slide.id} onChange={(e) => updateSlide(index, { id: e.target.value })} />
        </label>
      </VGroup>
    </>
  );
}

export function CellValues({ slide, index, ci }: { slide: Slide; index: number; ci: number }) {
  const updateSlide = useEditor((s) => s.updateSlide);
  const media = useEditor((s) => s.media);
  const [aiming, setAiming] = useState(false);
  const cell = slide.cells[ci];
  if (!cell) return null;
  const patch = (p: Partial<Cell>) =>
    updateSlide(index, { cells: slide.cells.map((c, i) => (i === ci ? { ...c, ...p } : c)) });

  /** Like patch, but against the store's current state — for async callbacks
   * (face detection) that land after this render's `slide` has gone stale. */
  const patchLater = (p: (c: Cell) => Partial<Cell>) =>
    useEditor.getState().mutate((proj) => ({
      ...proj,
      slides: proj.slides.map((sl, i) =>
        i === index
          ? { ...sl, cells: sl.cells.map((c, j) => (j === ci ? { ...c, ...p(c) } : c)) }
          : sl,
      ),
    }));

  // Smart fit needs a face region: reuse the cell's, then the bin's, then
  // detect fresh (projects imported before face regions existed).
  const pickSmart = () => {
    if (cell.smart_focus) {
      patch({ fit: "smart" });
      return;
    }
    const path = cell.source.type !== "solid" ? cell.source.path : null;
    const item = path ? media.find((m) => m.path === path) : undefined;
    const rect = item?.status === "ready" ? item.focusRect : null;
    if (rect) {
      patch({ fit: "smart", smart_focus: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] } });
      return;
    }
    patch({ fit: "smart" });
    if (path)
      detectFocus(path)
        .then((det) => {
          if (det)
            patchLater(() => ({
              smart_focus: { x: det.region[0], y: det.region[1], w: det.region[2], h: det.region[3] },
            }));
        })
        .catch(() => undefined);
  };

  // Detect faces and aim the zoom at them; also store the region so Smart
  // fit can reuse it.
  const autoFocus = async () => {
    if (cell.source.type === "solid" || aiming) return;
    setAiming(true);
    try {
      const det = await detectFocus(cell.source.path);
      if (det)
        patchLater((c) => ({
          smart_focus: {
            x: det.region[0],
            y: det.region[1],
            w: det.region[2],
            h: det.region[3],
          },
          motion: c.motion.type === "zoom" ? { ...c.motion, origin: det.point } : c.motion,
        }));
    } catch {
      // No faces or unreadable media — the zoom keeps its current aim.
    } finally {
      setAiming(false);
    }
  };

  const zoom = cell.motion.type === "zoom" ? cell.motion : null;
  const patchZoom = (p: Partial<Extract<Cell["motion"], { type: "zoom" }>>) => {
    if (zoom) patch({ motion: { ...zoom, ...p } });
  };

  return (
    <>
      <VGroup label="Motion">
        <Verbs
          label={motionLabel(cell.motion) === "None" ? "Still" : motionLabel(cell.motion)}
          options={MOTIONS.map((m) => ({
            label: m.label === "None" ? "Still" : m.label,
            active: motionLabel(cell.motion) === m.label,
            onPick: () => patch({ motion: m.value(cell) }),
          }))}
        />
        {zoom && (
          <>
            <SliderField label="From" value={zoom.from} min={0.5} max={3} step={0.01}
              onChange={(from) => patchZoom({ from })} />
            <SliderField label="To" value={zoom.to} min={0.5} max={3} step={0.01}
              onChange={(to) => patchZoom({ to })} />
            <SliderField label="Focus X" value={zoom.origin[0]} min={0} max={1} step={0.01} display="pct"
              onChange={(x) => patchZoom({ origin: [x, zoom.origin[1]] })} />
            <SliderField label="Focus Y" value={zoom.origin[1]} min={0} max={1} step={0.01} display="pct"
              onChange={(y) => patchZoom({ origin: [zoom.origin[0], y] })} />
            <div className="field">
              <span>Aim</span>
              <div className="field-input">
                <button onClick={autoFocus} disabled={aiming || cell.source.type === "solid"}>
                  {aiming ? "Finding faces…" : "Auto focus"}
                </button>
              </div>
            </div>
            <p className="hint">Drag the ◎ handle on the frame to aim the zoom.</p>
          </>
        )}
        {cell.motion.type === "ken_burns" && (
          <EchoRow label="Pan" value="Ken Burns crop (edit in the project file)" />
        )}
      </VGroup>
      <VGroup label="Fit">
        <Verbs
          label={cell.fit === "cover" ? "Fill" : cell.fit === "contain" ? "Whole photo" : "Smart"}
          options={[
            { label: "Fill", active: cell.fit === "cover", onPick: () => patch({ fit: "cover" }) },
            { label: "Whole photo", active: cell.fit === "contain", onPick: () => patch({ fit: "contain" }) },
            { label: "Smart", active: cell.fit === "smart", onPick: pickSmart },
          ]}
        />
      </VGroup>
      <VGroup label="Framing">
        <SliderField label="Corner" value={cell.corner_radius} min={0} max={0.1} step={0.005} display="pct"
          onChange={(v) => patch({ corner_radius: v })} />
        <Segmented
          label="Border"
          options={[
            { label: "Off", value: "off" },
            { label: "On", value: "on" },
          ]}
          value={cell.border ? "on" : "off"}
          onChange={(v) =>
            patch({ border: v === "on" ? { width: 0.004, color: "#ffffff", lip: 0 } : null })
          }
        />
        {cell.border && (
          <>
            <SliderField label="Width" value={cell.border.width} min={0.001} max={0.02} step={0.001} display="pct"
              onChange={(width) => patch({ border: { ...cell.border!, width } })} />
            <ColorField label="Color" value={cell.border.color}
              onChange={(color) => patch({ border: { ...cell.border!, color } })} />
            <Segmented
              label="Lip"
              options={[
                { label: "Off", value: "off", title: "Plain even border" },
                { label: "On", value: "on", title: "Instant-print caption lip below the photo" },
              ]}
              value={cell.border.lip > 0 ? "on" : "off"}
              onChange={(v) => patch({ border: { ...cell.border!, lip: v === "on" ? 0.035 : 0 } })}
            />
          </>
        )}
      </VGroup>
      {cell.source.type === "video" && (
        <VGroup label="Video">
          <NumField label="Clip start" value={cell.source.start} min={0} max={9999} step={0.5} display="s"
            onChange={(start) => patch({ source: { ...cell.source, start } as Cell["source"] })} />
          <Segmented
            label="Clip audio"
            options={[
              { label: "Off", value: "off" },
              { label: "On", value: "on" },
            ]}
            value={cell.source.mute ? "off" : "on"}
            onChange={(v) => patch({ source: { ...cell.source, mute: v === "off" } as Cell["source"] })}
          />
        </VGroup>
      )}
    </>
  );
}

export function TextValues({
  slide,
  index,
  ti,
  fonts,
}: {
  slide: Slide;
  index: number;
  ti: number;
  fonts: string[];
}) {
  const updateSlide = useEditor((s) => s.updateSlide);
  const mutate = useEditor((s) => s.mutate);
  const t = slide.texts[ti];
  if (!t) return null;
  const patch = (p: Partial<TextOverlay>) =>
    updateSlide(index, { texts: slide.texts.map((x, i) => (i === ti ? { ...x, ...p } : x)) });
  // Live font browsing: every step re-renders, one browse = one undo entry.
  const applyFont = (font: string | null, history: boolean) =>
    mutate(
      (p) => ({
        ...p,
        slides: p.slides.map((s, i) =>
          i === index
            ? { ...s, texts: s.texts.map((x, j) => (j === ti ? { ...x, font } : x)) }
            : s,
        ),
      }),
      { history },
    );

  return (
    <>
      <textarea
        rows={2}
        value={t.text}
        onChange={(e) => patch({ text: e.target.value })}
      />
      <VGroup label="Type">
        <FontPicker label="Font" fonts={fonts} value={t.font} onApply={applyFont} />
        <SliderField label="Size" value={t.size} min={0.01} max={0.3} step={0.005} display="pct"
          onChange={(size) => patch({ size })} />
        <ColorField label="Color" value={t.color} onChange={(color) => patch({ color })} />
        <SegmentedToggles
          label="Style"
          options={[
            { label: "B", active: t.weight >= 600, title: "Bold", onToggle: () => patch({ weight: t.weight >= 600 ? 400 : 700 }) },
            { label: <i>I</i>, active: t.italic, title: "Italic", onToggle: () => patch({ italic: !t.italic }) },
            { label: "S", active: t.shadow, title: "Shadow", onToggle: () => patch({ shadow: !t.shadow }) },
            { label: "▭", active: !!t.box_color, title: "Backing box", onToggle: () => patch({ box_color: t.box_color ? null : "#00000080" }) },
          ]}
        />
        <Segmented
          label="Align"
          options={[
            { label: "⟵", value: "left", title: "Left" },
            { label: "☰", value: "center", title: "Center" },
            { label: "⟶", value: "right", title: "Right" },
          ]}
          value={t.align}
          onChange={(align) => patch({ align })}
        />
      </VGroup>
      <VGroup label="Placement">
        <AnchorGrid
          value={t.anchor}
          onChange={(anchor) => {
            // Position is a placement preset: clicking a region puts the
            // text frame there and the offsets start over as nudges from it.
            patch({ anchor, offset: [0, 0] });
          }}
        />
        <SliderField label="Offset X" value={t.offset[0]} min={-1} max={1} step={0.01} display="pct"
          onChange={(v) => patch({ offset: [v, t.offset[1]] })} />
        <SliderField label="Offset Y" value={t.offset[1]} min={-1} max={1} step={0.01} display="pct"
          onChange={(v) => patch({ offset: [t.offset[0], v] })} />
      </VGroup>
      <VGroup label="Timing">
        <SliderField label="Appears" value={t.start} min={0} max={Math.max(slide.duration, t.start)} step={0.1} typeMax={120} display="s"
          onChange={(start) => patch({ start })} />
        <SliderField label="Until" value={t.end ?? slide.duration} min={0} max={Math.max(slide.duration, t.end ?? 0)} step={0.1} typeMax={120} display="s"
          onChange={(v) => patch({ end: v >= slide.duration - 0.01 ? null : Math.max(v, t.start + 0.1) })} />
        <SliderField label="Fade in" value={t.fade} min={0} max={5} step={0.05} display="s"
          onChange={(fade) => patch({ fade })} />
        <SliderField label="Fade out" value={t.fade_out ?? t.fade} min={0} max={5} step={0.05} display="s"
          onChange={(fade_out) => patch({ fade_out })} />
      </VGroup>
    </>
  );
}
