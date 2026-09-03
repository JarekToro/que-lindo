import { useEffect, useRef, useState } from "react";

/**
 * A live font browser: ◀ ▶ page through families, the dropdown list applies
 * on highlight (arrow keys included) so the preview re-renders as you move.
 * Enter/click keeps the highlighted font, Esc reverts to where the browse
 * began. One browse session coalesces into a single undo step via the
 * `history` flag on apply.
 */
export default function FontPicker({
  label,
  fonts,
  value,
  onApply,
}: {
  label: string;
  fonts: string[];
  /** Current family; null = theme default. */
  value: string | null;
  onApply: (font: string | null, history: boolean) => void;
}) {
  const options: (string | null)[] = [null, ...fonts];
  const index = Math.max(0, options.findIndex((f) => f === value));
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(index);
  const sessionOrigin = useRef<string | null>(null);
  const sessionPushed = useRef(false);
  const lastStep = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  /** Steps within 3s of each other share one undo entry. */
  const applyStep = (font: string | null) => {
    const now = Date.now();
    const fresh = now - lastStep.current > 3000;
    lastStep.current = now;
    onApply(font, fresh);
  };

  const step = (d: number) => {
    const next = Math.max(0, Math.min(options.length - 1, index + d));
    if (next !== index) applyStep(options[next]);
  };

  const openList = () => {
    sessionOrigin.current = value;
    sessionPushed.current = false;
    setHighlight(index);
    setOpen(true);
  };

  const applyBrowse = (i: number) => {
    setHighlight(i);
    onApply(options[i], !sessionPushed.current);
    sessionPushed.current = true;
  };

  const close = (keep: boolean) => {
    if (!keep && sessionPushed.current) {
      // Revert inside the same undo entry the browse opened.
      onApply(sessionOrigin.current, false);
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(".font-item.on");
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  return (
    <div className="vrow">
      <span className="vlabel">{label}</span>
      <span className="font-picker">
        <button
          title="Previous font"
          aria-label="Previous font"
          onClick={() => step(-1)}
          disabled={index <= 0}
        >
          ◀
        </button>
        <button
          className="font-current"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${label}: ${value ?? "theme default"}`}
          title="Browse fonts — arrow keys preview live, Enter keeps, Esc reverts"
          onClick={() => (open ? close(true) : openList())}
          onKeyDown={(e) => {
            if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
              e.preventDefault();
              openList();
            }
          }}
        >
          {value ?? "(theme default)"}
        </button>
        <button
          title="Next font"
          aria-label="Next font"
          onClick={() => step(1)}
          disabled={index >= options.length - 1}
        >
          ▶
        </button>
        {open && (
          <div
            className="font-pop"
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-label="Font families"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = Math.max(
                  0,
                  Math.min(options.length - 1, highlight + (e.key === "ArrowDown" ? 1 : -1)),
                );
                if (next !== highlight) applyBrowse(next);
              } else if (e.key === "Enter") {
                e.preventDefault();
                close(true);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close(false);
              }
              e.stopPropagation();
            }}
            onBlur={() => close(true)}
          >
            {options.map((f, i) => (
              <button
                key={f ?? "(default)"}
                className={`font-item ${i === highlight ? "on" : ""}`}
                role="option"
                aria-selected={i === highlight}
                onPointerEnter={() => {
                  if (i !== highlight) applyBrowse(i);
                }}
                onClick={() => close(true)}
              >
                <span className="font-name">{f ?? "(theme default)"}</span>
                {f && (
                  <span className="font-sample" style={{ fontFamily: f }} aria-hidden="true">
                    AaBb
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
  );
}
