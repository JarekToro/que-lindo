import { useEffect, useState } from "react";
import { listFonts } from "../api";
import { autoLayout, defaultText, lowerThird } from "../presets";
import { useEditor } from "../store";
import type {
  Anchor,
  AudioTrack,
  Cell,
  Layout,
  Slide,
  TextOverlay,
  TransitionKind,
} from "../types";

const LAYOUTS: { label: string; make: (n: number) => Layout }[] = [
  { label: "Single", make: () => ({ type: "single" }) },
  { label: "Columns", make: () => ({ type: "columns", weights: [] }) },
  { label: "Rows", make: () => ({ type: "rows", weights: [] }) },
  { label: "Grid 2×2", make: () => ({ type: "grid", rows: 2, cols: 2 }) },
  { label: "Grid 3×3", make: () => ({ type: "grid", rows: 3, cols: 3 }) },
  { label: "Featured ◧", make: () => ({ type: "featured", side: "left", ratio: 0.62 }) },
  { label: "Featured ◨", make: () => ({ type: "featured", side: "right", ratio: 0.62 }) },
];

const TRANSITIONS: { label: string; kind: TransitionKind }[] = [
  { label: "Cut", kind: { type: "cut" } },
  { label: "Crossfade", kind: { type: "cross_fade" } },
  { label: "Fade to black", kind: { type: "fade_black" } },
  { label: "Fade to white", kind: { type: "fade_white" } },
  { label: "Slide left", kind: { type: "slide", dir: "left" } },
  { label: "Slide right", kind: { type: "slide", dir: "right" } },
  { label: "Slide up", kind: { type: "slide", dir: "up" } },
  { label: "Slide down", kind: { type: "slide", dir: "down" } },
  { label: "Wipe left", kind: { type: "wipe", dir: "left" } },
  { label: "Wipe right", kind: { type: "wipe", dir: "right" } },
];

const ANCHORS: Anchor[] = [
  "top_left", "top_center", "top_right",
  "center_left", "center", "center_right",
  "bottom_left", "bottom_center", "bottom_right",
];

const MOTIONS: { label: string; value: (c: Cell) => Cell["motion"] }[] = [
  { label: "None", value: () => ({ type: "none" }) },
  { label: "Zoom in", value: () => ({ type: "zoom", from: 1.0, to: 1.15 }) },
  { label: "Zoom out", value: () => ({ type: "zoom", from: 1.15, to: 1.0 }) },
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

function motionLabel(m: Cell["motion"]): string {
  if (m.type === "none") return "None";
  if (m.type === "zoom") return m.to >= m.from ? "Zoom in" : "Zoom out";
  return m.from.x !== m.to.x ? "Pan →" : "Pan ↓";
}

function transitionLabel(k: TransitionKind): string {
  const found = TRANSITIONS.find((t) => JSON.stringify(t.kind) === JSON.stringify(k));
  return found?.label ?? "Crossfade";
}

function Num({
  label,
  value,
  onChange,
  min = 0,
  max = 60,
  step = 0.1,
  unit = "",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="field-input">
        <input
          type="number"
          value={Number(value.toFixed(3))}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        />
        {unit}
      </span>
    </label>
  );
}

/** A row of outcome-level verb buttons. */
function Verbs({
  label,
  options,
}: {
  label: string;
  options: { label: string; active: boolean; onPick: () => void }[];
}) {
  return (
    <div className="verb-group" role="group" aria-label={label}>
      <span className="verb-label">{label}</span>
      <div className="verb-row">
        {options.map((o) => (
          <button key={o.label} className={o.active ? "on" : ""} onClick={o.onPick}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Inspector() {
  const project = useEditor((s) => s.project);
  const index = useEditor((s) => s.selectedSlide);
  const mutate = useEditor((s) => s.mutate);
  const updateSlide = useEditor((s) => s.updateSlide);
  const selectedCell = useEditor((s) => s.selectedCell);
  const selectCell = useEditor((s) => s.selectCell);
  const selectedText = useEditor((s) => s.selectedText);
  const selectText = useEditor((s) => s.selectText);
  const [fonts, setFonts] = useState<string[]>([]);

  useEffect(() => {
    listFonts().then(setFonts).catch(() => setFonts([]));
  }, []);

  const slide: Slide | undefined = project.slides[index];
  if (!slide) {
    return <aside className="inspector hint">No slide selected</aside>;
  }

  const patchCell = (ci: number, patch: Partial<Cell>) =>
    updateSlide(index, {
      cells: slide.cells.map((c, i) => (i === ci ? { ...c, ...patch } : c)),
    });

  const patchText = (ti: number, patch: Partial<TextOverlay>) =>
    updateSlide(index, {
      texts: slide.texts.map((t, i) => (i === ti ? { ...t, ...patch } : t)),
    });

  const patchAudio = (ai: number, patch: Partial<AudioTrack>) =>
    mutate((p) => ({
      ...p,
      audio: p.audio.map((a, i) => (i === ai ? { ...a, ...patch } : a)),
    }));

  const layoutValue =
    LAYOUTS.findIndex((l) => JSON.stringify(l.make(slide.cells.length)) === JSON.stringify(slide.layout));

  // ---- the outcome panel: 3–5 verbs for what is selected ----
  const sameKind = (a: TransitionKind, b: TransitionKind) => a.type === b.type;
  const setKind = (kind: TransitionKind) =>
    updateSlide(index, { transition: { ...slide.transition, kind } });
  const setMotion = (ci: number, label: string) => {
    const m = MOTIONS.find((m) => m.label === label);
    if (m) patchCell(ci, { motion: m.value(slide.cells[ci]) });
  };
  const motionVerbs = (ci: number) =>
    MOTIONS.map((m) => ({
      label: m.label === "None" ? "Still" : m.label,
      active: motionLabel(slide.cells[ci].motion) === m.label,
      onPick: () => setMotion(ci, m.label),
    }));

  const focusText = selectedText !== null ? slide.texts[selectedText] : undefined;
  const focusCell = selectedCell !== null ? slide.cells[selectedCell] : undefined;
  const isGroup = slide.cells.length > 1;

  const groupLayouts: { label: string; make: () => Layout }[] = [
    { label: "Auto", make: () => autoLayout(slide.cells.length) },
    { label: "Grid", make: () => ({ type: "grid", rows: 2, cols: Math.ceil(slide.cells.length / 2) }) },
    { label: "Featured", make: () => ({ type: "featured", side: "left", ratio: 0.62 }) },
    { label: "Strip", make: () => ({ type: "columns", weights: [] }) },
  ];

  const outcome = (
    <div className="outcome">
      <div className="outcome-head">
        {focusText
          ? `Text on slide ${index + 1}`
          : focusCell
            ? `Photo ${selectedCell! + 1} of ${slide.cells.length}`
            : isGroup
              ? `Slide ${index + 1} · group of ${slide.cells.length}`
              : `Slide ${index + 1}`}
        {(focusText || focusCell) && (
          <button
            className="ghost"
            title="Back to the slide"
            onClick={() => {
              selectCell(null);
              selectText(null);
            }}
          >
            ← Slide
          </button>
        )}
      </div>

      {focusText ? (
        <>
          <textarea
            rows={2}
            value={focusText.text}
            onChange={(e) => patchText(selectedText!, { text: e.target.value })}
          />
          <Verbs
            label="Size"
            options={[
              { label: "Smaller", active: false, onPick: () => patchText(selectedText!, { size: Math.max(0.02, focusText.size - 0.01) }) },
              { label: "Bigger", active: false, onPick: () => patchText(selectedText!, { size: Math.min(0.3, focusText.size + 0.01) }) },
            ]}
          />
          <Verbs
            label={`Appears at ${focusText.start.toFixed(1)}s`}
            options={[
              { label: "Sooner", active: false, onPick: () => patchText(selectedText!, { start: Math.max(0, focusText.start - 0.5) }) },
              { label: "Later", active: false, onPick: () => patchText(selectedText!, { start: focusText.start + 0.5 }) },
            ]}
          />
        </>
      ) : focusCell ? (
        <>
          <Verbs label="Motion" options={motionVerbs(selectedCell!)} />
          <Verbs
            label="Fit"
            options={[
              { label: "Fill", active: focusCell.fit === "cover", onPick: () => patchCell(selectedCell!, { fit: "cover" }) },
              { label: "Whole photo", active: focusCell.fit === "contain", onPick: () => patchCell(selectedCell!, { fit: "contain" }) },
            ]}
          />
        </>
      ) : (
        <>
          {slide.cells.length === 1 && <Verbs label="Motion" options={motionVerbs(0)} />}
          {isGroup && (
            <Verbs
              label="Arrangement"
              options={groupLayouts.map((g) => ({
                label: g.label,
                active: JSON.stringify(g.make()) === JSON.stringify(slide.layout),
                onPick: () => updateSlide(index, { layout: g.make() }),
              }))}
            />
          )}
          <Verbs
            label={`On screen ${slide.duration.toFixed(1)}s`}
            options={[
              { label: "Shorter", active: false, onPick: () => updateSlide(index, { duration: Math.max(1, slide.duration - 1) }) },
              { label: "Longer", active: false, onPick: () => updateSlide(index, { duration: Math.min(120, slide.duration + 1) }) },
            ]}
          />
          {index > 0 && (
            <Verbs
              label="Arrives by"
              options={[
                { label: "Cut", active: sameKind(slide.transition.kind, { type: "cut" }), onPick: () => setKind({ type: "cut" }) },
                { label: "Fade", active: sameKind(slide.transition.kind, { type: "cross_fade" }), onPick: () => setKind({ type: "cross_fade" }) },
                { label: "Black", active: slide.transition.kind.type === "fade_black" || slide.transition.kind.type === "fade_white", onPick: () => setKind({ type: "fade_black" }) },
                { label: "Slide", active: slide.transition.kind.type === "slide", onPick: () => setKind({ type: "slide", dir: "left" }) },
                { label: "Wipe", active: slide.transition.kind.type === "wipe", onPick: () => setKind({ type: "wipe", dir: "left" }) },
              ]}
            />
          )}
          <Verbs
            label="Text"
            options={[
              ...slide.texts.slice(0, 3).map((t, ti) => ({
                label: t.text.trim() ? `“${t.text.slice(0, 14)}${t.text.length > 14 ? "…" : ""}”` : t.role,
                active: false,
                onPick: () => selectText(ti),
              })),
              {
                label: "+ Add",
                active: false,
                onPick: () => {
                  updateSlide(index, {
                    texts: [
                      ...slide.texts,
                      defaultText({ text: "Title", role: "title", size: 0.08, anchor: "center", offset: [0, 0], fade: 0.6 }),
                    ],
                  });
                  selectText(slide.texts.length);
                },
              },
            ]}
          />
        </>
      )}
    </div>
  );

  return (
    <aside className="inspector">
      {outcome}
      <details className="values">
        <summary>Values</summary>
      <details open>
        <summary>Slide</summary>
        <label className="field">
          <span>Label</span>
          <input value={slide.id} onChange={(e) => updateSlide(index, { id: e.target.value })} />
        </label>
        <Num label="Duration" value={slide.duration} min={0.5} max={120} step={0.5} unit="s"
          onChange={(v) => updateSlide(index, { duration: Math.max(0.5, v) })} />
        <label className="field">
          <span>Layout</span>
          <select
            value={layoutValue >= 0 ? layoutValue : ""}
            onChange={(e) => updateSlide(index, { layout: LAYOUTS[+e.target.value].make(slide.cells.length) })}
          >
            {layoutValue < 0 && <option value="">(custom)</option>}
            {LAYOUTS.map((l, i) => (
              <option key={l.label} value={i}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <Num label="Margin" value={slide.margin} max={0.2} step={0.01}
          onChange={(v) => updateSlide(index, { margin: v })} />
        <Num label="Gutter" value={slide.gutter} max={0.1} step={0.005}
          onChange={(v) => updateSlide(index, { gutter: v })} />
        {index > 0 && (
          <>
            <label className="field">
              <span>Transition</span>
              <select
                value={transitionLabel(slide.transition.kind)}
                onChange={(e) => {
                  const t = TRANSITIONS.find((t) => t.label === e.target.value)!;
                  updateSlide(index, { transition: { ...slide.transition, kind: t.kind } });
                }}
              >
                {TRANSITIONS.map((t) => (
                  <option key={t.label}>{t.label}</option>
                ))}
              </select>
            </label>
            <Num label="Trans. time" value={slide.transition.duration} max={5} step={0.1} unit="s"
              onChange={(v) => updateSlide(index, { transition: { ...slide.transition, duration: v } })} />
          </>
        )}
        <label className="field">
          <span>Background</span>
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
        {slide.background.type === "color" && (
          <label className="field">
            <span>Color</span>
            <input
              type="color"
              value={slide.background.color.slice(0, 7)}
              onChange={(e) => updateSlide(index, { background: { type: "color", color: e.target.value } })}
            />
          </label>
        )}
      </details>

      <details open>
        <summary>Cells ({slide.cells.length})</summary>
        {slide.cells.map((c, ci) => (
          <div key={ci} className={`sub-card ${selectedCell === ci ? "selected" : ""}`} onClick={() => selectCell(ci)}>
            <div className="sub-head">
              <span>
                #{ci + 1}{" "}
                {c.source.type === "solid" ? "color" : c.source.path.replace(/^.*[/\\]/, "")}
              </span>
              <span>
                <button title="Move up" onClick={() => {
                  if (ci === 0) return;
                  const cells = [...slide.cells];
                  [cells[ci - 1], cells[ci]] = [cells[ci], cells[ci - 1]];
                  updateSlide(index, { cells });
                }}>↑</button>
                <button title="Remove" onClick={() => updateSlide(index, { cells: slide.cells.filter((_, i) => i !== ci) })}>✕</button>
              </span>
            </div>
            <label className="field">
              <span>Fit</span>
              <select value={c.fit} onChange={(e) => patchCell(ci, { fit: e.target.value as Cell["fit"] })}>
                <option value="cover">Cover (crop)</option>
                <option value="contain">Contain (letterbox)</option>
              </select>
            </label>
            <label className="field">
              <span>Motion</span>
              <select
                value={motionLabel(c.motion)}
                onChange={(e) => {
                  const m = MOTIONS.find((m) => m.label === e.target.value)!;
                  patchCell(ci, { motion: m.value(c) });
                }}
              >
                {MOTIONS.map((m) => (
                  <option key={m.label}>{m.label}</option>
                ))}
              </select>
            </label>
            <Num label="Corner" value={c.corner_radius} max={0.1} step={0.005}
              onChange={(v) => patchCell(ci, { corner_radius: v })} />
            <label className="field">
              <span>Border</span>
              <input
                type="checkbox"
                checked={!!c.border}
                onChange={(e) =>
                  patchCell(ci, { border: e.target.checked ? { width: 0.004, color: "#ffffff" } : null })
                }
              />
            </label>
            {c.source.type === "video" && (
              <>
                <Num label="Clip start" value={c.source.start} max={9999} step={0.5} unit="s"
                  onChange={(v) => patchCell(ci, { source: { ...c.source, start: v } as Cell["source"] })} />
                <label className="field">
                  <span>Use clip audio</span>
                  <input
                    type="checkbox"
                    checked={!c.source.mute}
                    onChange={(e) =>
                      patchCell(ci, { source: { ...c.source, mute: !e.target.checked } as Cell["source"] })
                    }
                  />
                </label>
              </>
            )}
          </div>
        ))}
        {slide.cells.length === 0 && <p className="hint">Drop a photo from the timeline or shelf onto this slide.</p>}
      </details>

      <details open>
        <summary>Text ({slide.texts.length})</summary>
        <div className="row">
          <button onClick={() => updateSlide(index, { texts: [...slide.texts, defaultText({ text: "Caption", role: "caption" })] })}>
            + Caption
          </button>
          <button onClick={() =>
            updateSlide(index, {
              texts: [...slide.texts, defaultText({ text: "Title", role: "title", size: 0.09, anchor: "center", offset: [0, 0] })],
            })
          }>
            + Title
          </button>
          <button onClick={() => {
            const name = prompt("Name:") ?? "Name";
            const dates = prompt("Dates:") ?? "";
            updateSlide(index, { texts: [...slide.texts, ...lowerThird(name, dates)] });
          }}>
            + Lower third
          </button>
        </div>
        {slide.texts.map((t, ti) => (
          <div key={ti} className={`sub-card ${selectedText === ti ? "selected" : ""}`} onClick={() => selectText(ti)}>
            <div className="sub-head">
              <span>{t.role}</span>
              <button title="Remove" onClick={() => updateSlide(index, { texts: slide.texts.filter((_, i) => i !== ti) })}>✕</button>
            </div>
            <textarea
              rows={2}
              value={t.text}
              onChange={(e) => patchText(ti, { text: e.target.value })}
            />
            <label className="field">
              <span>Font</span>
              <select
                value={t.font ?? ""}
                onChange={(e) => patchText(ti, { font: e.target.value || null })}
              >
                <option value="">(theme default)</option>
                {fonts.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <Num label="Size" value={t.size} min={0.01} max={0.3} step={0.005}
              onChange={(v) => patchText(ti, { size: v })} />
            <label className="field">
              <span>Color</span>
              <input type="color" value={t.color.slice(0, 7)} onChange={(e) => patchText(ti, { color: e.target.value })} />
            </label>
            <label className="field">
              <span>Style</span>
              <span className="field-input">
                <button className={t.weight >= 600 ? "on" : ""} onClick={() => patchText(ti, { weight: t.weight >= 600 ? 400 : 700 })}>B</button>
                <button className={t.italic ? "on" : ""} onClick={() => patchText(ti, { italic: !t.italic })}><i>I</i></button>
                <button className={t.shadow ? "on" : ""} title="Shadow" onClick={() => patchText(ti, { shadow: !t.shadow })}>S</button>
                <button className={t.box_color ? "on" : ""} title="Backing box" onClick={() => patchText(ti, { box_color: t.box_color ? null : "#00000080" })}>▭</button>
              </span>
            </label>
            <label className="field">
              <span>Align</span>
              <select value={t.align} onChange={(e) => patchText(ti, { align: e.target.value as TextOverlay["align"] })}>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label className="field">
              <span>Position</span>
              <span className="anchor-grid">
                {ANCHORS.map((a) => (
                  <button key={a} className={t.anchor === a ? "on" : ""} onClick={() => patchText(ti, { anchor: a })} />
                ))}
              </span>
            </label>
            <Num label="Offset X" value={t.offset[0]} min={-0.5} max={0.5} step={0.01}
              onChange={(v) => patchText(ti, { offset: [v, t.offset[1]] })} />
            <Num label="Offset Y" value={t.offset[1]} min={-0.5} max={0.5} step={0.01}
              onChange={(v) => patchText(ti, { offset: [t.offset[0], v] })} />
            <Num label="Appear at" value={t.start} max={120} step={0.1} unit="s"
              onChange={(v) => patchText(ti, { start: v })} />
            <Num label="Fade" value={t.fade} max={5} step={0.05} unit="s"
              onChange={(v) => patchText(ti, { fade: v })} />
          </div>
        ))}
      </details>

      <details open>
        <summary>Music ({project.audio.length})</summary>
        {project.audio.map((a, ai) => (
          <div key={ai} className="sub-card">
            <div className="sub-head">
              <span>{a.path.replace(/^.*[/\\]/, "")}</span>
              <button title="Remove" onClick={() => mutate((p) => ({ ...p, audio: p.audio.filter((_, i) => i !== ai) }))}>✕</button>
            </div>
            <Num label="Start at" value={a.start} max={9999} step={0.5} unit="s" onChange={(v) => patchAudio(ai, { start: v })} />
            <Num label="Gain" value={a.gain_db} min={-40} max={12} step={1} unit="dB" onChange={(v) => patchAudio(ai, { gain_db: v })} />
            <Num label="Fade in" value={a.fade_in} max={20} step={0.5} unit="s" onChange={(v) => patchAudio(ai, { fade_in: v })} />
            <Num label="Fade out" value={a.fade_out} max={20} step={0.5} unit="s" onChange={(v) => patchAudio(ai, { fade_out: v })} />
            <label className="field">
              <span>Loop</span>
              <input type="checkbox" checked={a.loop} onChange={(e) => patchAudio(ai, { loop: e.target.checked })} />
            </label>
          </div>
        ))}
        {project.audio.length === 0 && <p className="hint">Add music from the “Not used” shelf (+ Music).</p>}
      </details>

      <details>
        <summary>Project</summary>
        <Num label="FPS" value={project.settings.fps} min={10} max={60} step={1}
          onChange={(v) => mutate((p) => ({ ...p, settings: { ...p.settings, fps: v } }))} />
        <label className="field">
          <span>Background</span>
          <input
            type="color"
            value={project.settings.background.slice(0, 7)}
            onChange={(e) => mutate((p) => ({ ...p, settings: { ...p.settings, background: e.target.value } }))}
          />
        </label>
      </details>
      </details>
    </aside>
  );
}
