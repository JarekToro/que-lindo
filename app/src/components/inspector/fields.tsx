// Field primitives for the Values pane — the precision layer's controls.
// All are controlled and store-free: value in, patch out.

import type { ReactNode } from "react";
import type { Anchor } from "../../types";

export type NumDisplay = "pct" | "s" | "dB" | "raw";

const UNIT: Record<NumDisplay, string> = { pct: "%", s: "s", dB: "dB", raw: "" };

function toShown(value: number, display: NumDisplay): number {
  return display === "pct" ? Math.round(value * 1000) / 10 : Math.round(value * 100) / 100;
}

function fromShown(shown: number, display: NumDisplay): number {
  return display === "pct" ? shown / 100 : shown;
}

/** Right-aligned numeric input with its unit inside the field. `pct` fields
 * show percent but store frame fractions. */
export function NumField({
  label,
  value,
  onChange,
  min = 0,
  max = 120,
  step = 0.1,
  display = "raw",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  display?: NumDisplay;
}) {
  return (
    <label className="vrow">
      <span className="vlabel">{label}</span>
      <span className="num-unit">
        <input
          type="number"
          value={toShown(value, display)}
          min={display === "pct" ? min * 100 : min}
          max={display === "pct" ? max * 100 : max}
          step={display === "pct" ? step * 100 : step}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (!Number.isNaN(n)) onChange(fromShown(n, display));
          }}
        />
        {UNIT[display] && <span className="unit">{UNIT[display]}</span>}
      </span>
    </label>
  );
}

/** Slider with a typeable mono readout — for fields whose range is known. */
export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  display = "raw",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  display?: NumDisplay;
}) {
  return (
    <div className="vrow">
      <span className="vlabel">{label}</span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="num-unit readout">
        <input
          type="number"
          value={toShown(value, display)}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (!Number.isNaN(n))
              onChange(Math.max(min, Math.min(max, fromShown(n, display))));
          }}
        />
        {UNIT[display] && <span className="unit">{UNIT[display]}</span>}
      </span>
    </div>
  );
}

/** Joined buttons, exactly one active. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { label: string; value: T; title?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="vrow">
      <span className="vlabel">{label}</span>
      <span className="segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            className={value === o.value ? "on" : ""}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** Joined buttons, each independently on/off (text style B/I/S/▭). */
export function SegmentedToggles({
  label,
  options,
}: {
  label: string;
  options: { label: ReactNode; active: boolean; title: string; onToggle: () => void }[];
}) {
  return (
    <div className="vrow">
      <span className="vlabel">{label}</span>
      <span className="segmented" role="group" aria-label={label}>
        {options.map((o, i) => (
          <button key={i} className={o.active ? "on" : ""} title={o.title} onClick={o.onToggle}>
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** Swatch + hex readout. */
export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="vrow">
      <span className="vlabel">{label}</span>
      <span className="color-field">
        <input type="color" value={value.slice(0, 7)} onChange={(e) => onChange(e.target.value)} />
        <span className="hex">{value.slice(0, 7)}</span>
      </span>
    </label>
  );
}

const ANCHORS: Anchor[] = [
  "top_left", "top_center", "top_right",
  "center_left", "center", "center_right",
  "bottom_left", "bottom_center", "bottom_right",
];

export function AnchorGrid({
  value,
  onChange,
}: {
  value: Anchor;
  onChange: (a: Anchor) => void;
}) {
  return (
    <div className="vrow">
      <span className="vlabel">Position</span>
      <span className="anchor-grid">
        {ANCHORS.map((a) => (
          <button
            key={a}
            className={value === a ? "on" : ""}
            title={a.replace("_", " ")}
            onClick={() => onChange(a)}
          />
        ))}
      </span>
    </div>
  );
}

/** Muted echo of a value a verb above owns — context, not a control. */
export function EchoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="vrow">
      <span className="vlabel">{label}</span>
      <span className="vecho">{value}</span>
    </div>
  );
}

/** Uppercase group label for a cluster of rows. */
export function VGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="vgroup">
      <span className="vgroup-label">{label}</span>
      {children}
    </div>
  );
}
