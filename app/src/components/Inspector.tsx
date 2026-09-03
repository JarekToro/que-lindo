import { useEffect, useMemo, useState } from "react";
import { detectFocus, listFonts } from "../api";
import { autoLayout, defaultText, lowerThird } from "../presets";
import { useEditor } from "../store";
import type { Cell, Layout, MediaItem, Slide, TextOverlay, TransitionKind } from "../types";
import Menu from "./Menu";
import { MOTIONS, motionLabel } from "./inspector/data";
import ProjectValues from "./inspector/ProjectValues";
import ValuesPane from "./inspector/ValuesPane";

/** A row of outcome-level verb buttons. `select` marks a row where exactly one
 * option holds — the `.on` state is then also carried as aria-pressed. */
function Verbs({
  label,
  options,
  select = false,
}: {
  label: string;
  options: { label: string; active: boolean; onPick: () => void }[];
  select?: boolean;
}) {
  return (
    <div className="verb-group" role="group" aria-label={label}>
      <span className="verb-label">{label}</span>
      <div className="verb-row">
        {options.map((o) => (
          <button
            key={o.label}
            className={o.active ? "on" : ""}
            aria-pressed={select ? o.active : undefined}
            onClick={o.onPick}
          >
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
  const media = useEditor((s) => s.media);
  const playSlide = useEditor((s) => s.playSlide);
  const [fonts, setFonts] = useState<string[]>([]);

  useEffect(() => {
    listFonts().then(setFonts).catch(() => setFonts([]));
  }, []);

  const thumbs = useMemo(() => new Map(media.map((m) => [m.path, m])), [media]);
  const thumbFor = (c: Cell): string | null => {
    if (c.source.type === "solid") return null;
    const m: MediaItem | undefined = thumbs.get(c.source.path);
    return m && m.status === "ready" ? m.thumb : null;
  };

  const slide: Slide | undefined = project.slides[index];

  if (!slide) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <p className="hint">No slide selected</p>
        <ProjectValues />
      </aside>
    );
  }

  const patchCell = (ci: number, patch: Partial<Cell>) =>
    updateSlide(index, {
      cells: slide.cells.map((c, i) => (i === ci ? { ...c, ...patch } : c)),
    });

  /** Like patchCell, but against the store's current state — for async
   * callbacks (face detection) that land after `slide` has gone stale. */
  const patchCellLater = (ci: number, patch: (c: Cell) => Partial<Cell>) =>
    useEditor.getState().mutate((p) => ({
      ...p,
      slides: p.slides.map((sl, i) =>
        i === index
          ? { ...sl, cells: sl.cells.map((c, j) => (j === ci ? { ...c, ...patch(c) } : c)) }
          : sl,
      ),
    }));

  const patchText = (ti: number, patch: Partial<TextOverlay>) =>
    updateSlide(index, {
      texts: slide.texts.map((t, i) => (i === ti ? { ...t, ...patch } : t)),
    });

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

  // Smart fit needs a face region: reuse the cell's, then the bin's, then
  // detect fresh (projects imported before face regions existed).
  const pickSmart = (ci: number) => {
    const cell = slide.cells[ci];
    if (cell.smart_focus) {
      patchCell(ci, { fit: "smart" });
      return;
    }
    const path = cell.source.type !== "solid" ? cell.source.path : null;
    const item = path ? thumbs.get(path) : undefined;
    const rect = item?.status === "ready" ? item.focusRect : null;
    if (rect) {
      patchCell(ci, { fit: "smart", smart_focus: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] } });
      return;
    }
    patchCell(ci, { fit: "smart" });
    if (path)
      detectFocus(path)
        .then((det) => {
          if (det)
            patchCellLater(ci, () => ({
              smart_focus: { x: det.region[0], y: det.region[1], w: det.region[2], h: det.region[3] },
            }));
        })
        .catch(() => undefined);
  };

  const focusText = selectedText !== null ? slide.texts[selectedText] : undefined;
  const focusCell = selectedCell !== null ? slide.cells[selectedCell] : undefined;
  const isGroup = slide.cells.length > 1;

  const groupLayouts: { label: string; make: () => Layout }[] = [
    { label: "Auto", make: () => autoLayout(slide.cells.length) },
    { label: "Grid", make: () => ({ type: "grid", rows: 2, cols: Math.ceil(slide.cells.length / 2) }) },
    { label: "Featured", make: () => ({ type: "featured", side: "left", ratio: 0.62 }) },
    { label: "Strip", make: () => ({ type: "columns", weights: [] }) },
  ];

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
        <span className="head-actions">
          <button
            className="ghost"
            title="Play just this slide, from its start"
            aria-label={`Play slide ${index + 1} from its start`}
            onClick={() => playSlide(index)}
          >
            ▶ Slide
          </button>
          {(focusText || focusCell) && (
            <button
              className="ghost"
              title="Back to the slide"
              aria-label="Back to the slide"
              onClick={() => {
                selectCell(null);
                selectText(null);
              }}
            >
              ← Slide
            </button>
          )}
        </span>
      </div>

      {focusText ? (
        <>
          <textarea
            rows={2}
            aria-label="Text content"
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
          <Verbs label="Motion" select options={motionVerbs(selectedCell!)} />
          <Verbs
            label="Fit"
            select
            options={[
              { label: "Fill", active: focusCell.fit === "cover", onPick: () => patchCell(selectedCell!, { fit: "cover" }) },
              { label: "Whole photo", active: focusCell.fit === "contain", onPick: () => patchCell(selectedCell!, { fit: "contain" }) },
              { label: "Smart", active: focusCell.fit === "smart", onPick: () => pickSmart(selectedCell!) },
            ]}
          />
        </>
      ) : (
        <>
          {slide.cells.length === 1 && <Verbs label="Motion" select options={motionVerbs(0)} />}
          {isGroup && (
            <Verbs
              label="Arrangement"
              select
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
          <Verbs
            label={index === 0 ? "Opens with" : "Arrives by"}
            select
            options={[
              { label: "Cut", active: sameKind(slide.transition.kind, { type: "cut" }), onPick: () => setKind({ type: "cut" }) },
              { label: "Fade", active: sameKind(slide.transition.kind, { type: "cross_fade" }), onPick: () => setKind({ type: "cross_fade" }) },
              { label: "Black", active: slide.transition.kind.type === "fade_black" || slide.transition.kind.type === "fade_white", onPick: () => setKind({ type: "fade_black" }) },
              { label: "Slide", active: slide.transition.kind.type === "slide", onPick: () => setKind({ type: "slide", dir: "left" }) },
              { label: "Wipe", active: slide.transition.kind.type === "wipe", onPick: () => setKind({ type: "wipe", dir: "left" }) },
            ]}
          />
          {index === project.slides.length - 1 && (
            <Verbs
              label="Ends with"
              select
              options={(
                [
                  ["Cut", { type: "cut" }],
                  ["Fade", { type: "cross_fade" }],
                  ["Black", { type: "fade_black" }],
                  ["Slide", { type: "slide", dir: "left" }],
                  ["Wipe", { type: "wipe", dir: "left" }],
                ] as [string, TransitionKind][]
              ).map(([label, kind]) => ({
                label,
                active: project.outro.kind.type === kind.type,
                onPick: () =>
                  mutate((p) => ({
                    ...p,
                    outro: {
                      kind,
                      duration:
                        kind.type === "cut" ? 0 : p.outro.duration > 0.05 ? p.outro.duration : 1.5,
                    },
                  })),
              }))}
            />
          )}
          <div className="verb-group" role="group" aria-label="Text">
            <span className="verb-label">Text</span>
            <div className="verb-row">
              {slide.texts.slice(0, 3).map((t, ti) => (
                <button key={ti} onClick={() => selectText(ti)}>
                  {t.text.trim() ? `“${t.text.slice(0, 14)}${t.text.length > 14 ? "…" : ""}”` : t.role}
                </button>
              ))}
              <Menu
                label="+ Add ▾"
                ariaLabel="Add text"
                items={[
                  { label: "Title", onPick: () => addText("title") },
                  { label: "Caption", onPick: () => addText("caption") },
                  { label: "Lower third", onPick: () => addText("lower") },
                ]}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );

  return (
    <aside className="inspector" aria-label="Inspector">
      {outcome}
      <ValuesPane slide={slide} index={index} fonts={fonts} thumbFor={thumbFor} />
      <ProjectValues />
    </aside>
  );
}
