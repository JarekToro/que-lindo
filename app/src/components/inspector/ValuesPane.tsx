// The Values pane: raw fields for the current selection only — the precision
// layer under the outcome verbs. Slide scope shows the member strip and the
// slide's canvas numbers; selecting a member (here or anywhere) swaps in that
// member's fields.

import { useState } from "react";
import { detectFocus } from "../../api";
import { useEditor } from "../../store";
import type { Cell, Slide, TextOverlay } from "../../types";
import { kindLabel, LAYOUTS } from "./data";
import FontPicker from "./FontPicker";
import {
  AnchorGrid,
  ColorField,
  EchoRow,
  NumField,
  Segmented,
  SegmentedToggles,
  SliderField,
  VGroup,
} from "./fields";

function cellName(c: Cell): string {
  return c.source.type === "solid" ? "color" : c.source.path.replace(/^.*[/\\]/, "");
}

function MemberStrip({
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

  if (slide.cells.length === 0 && slide.texts.length === 0) {
    return <p className="hint">Drop a photo from the timeline or shelf onto this slide.</p>;
  }
  return (
    <div className="member-strip">
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
          <button
            className="chip-body"
            title={t.text || t.role}
            onClick={() => selectText(ti)}
          >
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
    </div>
  );
}

function SlideValues({ slide, index }: { slide: Slide; index: number }) {
  const updateSlide = useEditor((s) => s.updateSlide);
  const layoutValue = LAYOUTS.findIndex(
    (l) => JSON.stringify(l.make(slide.cells.length)) === JSON.stringify(slide.layout),
  );
  const kind = slide.transition.kind;
  const directional = kind.type === "slide" || kind.type === "wipe";
  const bg = slide.background;

  return (
    <>
      <VGroup label="Timing">
        <NumField label="On screen" value={slide.duration} min={0.5} max={120} step={0.1} display="s"
          onChange={(v) => updateSlide(index, { duration: Math.max(0.5, v) })} />
      </VGroup>
      <VGroup label="Canvas">
        <label className="vrow">
          <span className="vlabel">Layout</span>
          <select
            value={layoutValue >= 0 ? layoutValue : ""}
            onChange={(e) =>
              updateSlide(index, { layout: LAYOUTS[+e.target.value].make(slide.cells.length) })
            }
          >
            {layoutValue < 0 && <option value="">(custom)</option>}
            {LAYOUTS.map((l, i) => (
              <option key={l.label} value={i}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <SliderField label="Margin" value={slide.margin} min={0} max={0.2} step={0.01} display="pct"
          onChange={(v) => updateSlide(index, { margin: v })} />
        <SliderField label="Gutter" value={slide.gutter} min={0} max={0.1} step={0.005} display="pct"
          onChange={(v) => updateSlide(index, { gutter: v })} />
        <label className="vrow">
          <span className="vlabel">Background</span>
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
      <VGroup label={index === 0 ? "Opens with" : "Transition"}>
        <EchoRow label={index === 0 ? "Opens by" : "Arrives by"} value={kindLabel(kind)} />
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
      <VGroup label="Label">
        <label className="vrow">
          <span className="vlabel">Label</span>
          <input value={slide.id} onChange={(e) => updateSlide(index, { id: e.target.value })} />
        </label>
      </VGroup>
    </>
  );
}

function CellValues({ slide, index, ci }: { slide: Slide; index: number; ci: number }) {
  const updateSlide = useEditor((s) => s.updateSlide);
  const [aiming, setAiming] = useState(false);
  const cell = slide.cells[ci];
  if (!cell) return null;
  const patch = (p: Partial<Cell>) =>
    updateSlide(index, { cells: slide.cells.map((c, i) => (i === ci ? { ...c, ...p } : c)) });

  // Detect faces and aim the zoom at them; also store the region so Smart
  // fit can reuse it. Patches against the store's current state — the
  // detection lands after this render's `slide` has gone stale.
  const autoFocus = async () => {
    if (cell.source.type === "solid" || aiming) return;
    setAiming(true);
    try {
      const det = await detectFocus(cell.source.path);
      if (det)
        useEditor.getState().mutate((p) => ({
          ...p,
          slides: p.slides.map((sl, i) =>
            i === index
              ? {
                  ...sl,
                  cells: sl.cells.map((c, j) =>
                    j === ci
                      ? {
                          ...c,
                          smart_focus: {
                            x: det.region[0],
                            y: det.region[1],
                            w: det.region[2],
                            h: det.region[3],
                          },
                          motion:
                            c.motion.type === "zoom" ? { ...c.motion, origin: det.point } : c.motion,
                        }
                      : c,
                  ),
                }
              : sl,
          ),
        }));
    } catch {
      // No faces or unreadable media — the zoom keeps its current aim.
    } finally {
      setAiming(false);
    }
  };

  return (
    <>
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
            patch({ border: v === "on" ? { width: 0.004, color: "#ffffff" } : null })
          }
        />
        {cell.border && (
          <>
            <SliderField label="Width" value={cell.border.width} min={0.001} max={0.02} step={0.001} display="pct"
              onChange={(width) => patch({ border: { ...cell.border!, width } })} />
            <ColorField label="Color" value={cell.border.color}
              onChange={(color) => patch({ border: { ...cell.border!, color } })} />
          </>
        )}
      </VGroup>
      {cell.motion.type === "zoom" && (
        <VGroup label="Motion detail">
          <NumField label="Zoom from" value={cell.motion.from} min={0.5} max={3} step={0.01}
            onChange={(from) => patch({ motion: { ...(cell.motion as Extract<Cell["motion"], { type: "zoom" }>), from } })} />
          <NumField label="Zoom to" value={cell.motion.to} min={0.5} max={3} step={0.01}
            onChange={(to) => patch({ motion: { ...(cell.motion as Extract<Cell["motion"], { type: "zoom" }>), to } })} />
          <NumField label="Focus X" value={cell.motion.origin[0]} min={0} max={1} step={0.01} display="pct"
            onChange={(x) => {
              const m = cell.motion as Extract<Cell["motion"], { type: "zoom" }>;
              patch({ motion: { ...m, origin: [x, m.origin[1]] } });
            }} />
          <NumField label="Focus Y" value={cell.motion.origin[1]} min={0} max={1} step={0.01} display="pct"
            onChange={(y) => {
              const m = cell.motion as Extract<Cell["motion"], { type: "zoom" }>;
              patch({ motion: { ...m, origin: [m.origin[0], y] } });
            }} />
          <div className="field">
            <span>Aim</span>
            <div className="field-input">
              <button onClick={autoFocus} disabled={aiming || cell.source.type === "solid"}>
                {aiming ? "Finding faces…" : "Auto focus"}
              </button>
            </div>
          </div>
          <p className="hint">Drag the ◎ handle on the frame to aim the zoom.</p>
        </VGroup>
      )}
      {cell.motion.type === "ken_burns" && (
        <VGroup label="Motion detail">
          <EchoRow label="Pan" value="Ken Burns crop (edit in the project file)" />
        </VGroup>
      )}
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

function TextValues({
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
        <NumField label="Offset X" value={t.offset[0]} min={-1} max={1} step={0.01} display="pct"
          onChange={(v) => patch({ offset: [v, t.offset[1]] })} />
        <NumField label="Offset Y" value={t.offset[1]} min={-1} max={1} step={0.01} display="pct"
          onChange={(v) => patch({ offset: [t.offset[0], v] })} />
      </VGroup>
      <VGroup label="Timing">
        <NumField label="Appear at" value={t.start} min={0} max={120} step={0.1} display="s"
          onChange={(start) => patch({ start })} />
        <NumField label="Until" value={t.end ?? slide.duration} min={0} max={120} step={0.1} display="s"
          onChange={(v) => patch({ end: v >= slide.duration - 0.01 ? null : Math.max(v, t.start + 0.1) })} />
        <NumField label="Fade in" value={t.fade} min={0} max={5} step={0.05} display="s"
          onChange={(fade) => patch({ fade })} />
        <NumField label="Fade out" value={t.fade_out ?? t.fade} min={0} max={5} step={0.05} display="s"
          onChange={(fade_out) => patch({ fade_out })} />
      </VGroup>
    </>
  );
}

export default function ValuesPane({
  slide,
  index,
  fonts,
  thumbFor,
}: {
  slide: Slide;
  index: number;
  fonts: string[];
  thumbFor: (c: Cell) => string | null;
}) {
  const selectedCell = useEditor((s) => s.selectedCell);
  const selectedText = useEditor((s) => s.selectedText);
  const selectedIds = useEditor((s) => s.selectedIds);

  const scope =
    selectedCell !== null
      ? `Photo ${selectedCell + 1}`
      : selectedText !== null
        ? "Text"
        : selectedIds.length > 1
          ? `Slide ${index + 1} · editing anchor (${selectedIds.length} selected)`
          : `Slide ${index + 1}`;

  return (
    <details className="values">
      <summary>
        Values <span className="values-scope">· {scope}</span>
      </summary>
      {selectedCell !== null ? (
        <CellValues slide={slide} index={index} ci={selectedCell} />
      ) : selectedText !== null ? (
        <TextValues slide={slide} index={index} ti={selectedText} fonts={fonts} />
      ) : (
        <>
          <VGroup label="Members">
            <MemberStrip slide={slide} index={index} thumbFor={thumbFor} />
          </VGroup>
          <SlideValues slide={slide} index={index} />
        </>
      )}
    </details>
  );
}
