import { useRef } from "react";

/**
 * A drag handle between panels. `axis` is the drag direction ("x" resizes
 * widths, "y" heights); `sign` maps pointer movement to size growth (+1 when
 * dragging right/down grows the panel, -1 when the panel sits on the other
 * side of the handle). Arrow keys resize too.
 */
export default function Splitter({
  axis,
  sign,
  value,
  min,
  max,
  onChange,
  label,
}: {
  axis: "x" | "y";
  sign: 1 | -1;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const start = useRef({ pos: 0, value: 0 });
  const clamp = (v: number) => Math.max(min, Math.min(max, v));

  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { pos: axis === "x" ? e.clientX : e.clientY, value };
      }}
      onPointerMove={(e) => {
        if (!(e.buttons & 1)) return;
        const pos = axis === "x" ? e.clientX : e.clientY;
        onChange(clamp(start.current.value + (pos - start.current.pos) * sign));
      }}
      onKeyDown={(e) => {
        const grow =
          axis === "x"
            ? e.key === "ArrowRight"
              ? sign
              : e.key === "ArrowLeft"
                ? -sign
                : 0
            : e.key === "ArrowDown"
              ? sign
              : e.key === "ArrowUp"
                ? -sign
                : 0;
        if (grow !== 0) {
          e.preventDefault();
          onChange(clamp(value + grow * 16));
        }
      }}
    />
  );
}
