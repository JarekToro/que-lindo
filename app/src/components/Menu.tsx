import { useEffect, useRef, useState } from "react";

/**
 * A drop button and its item list. The list still opens on hover for the
 * mouse; the keyboard opens it with Enter/Space/↓, walks it with the arrows
 * and closes it with Escape, returning focus to the button.
 */
export default function Menu({
  label,
  items,
  ariaLabel,
}: {
  label: string;
  items: { label: string; onPick: () => void }[];
  /** Accessible name when `label` is a glyph run like "+ Add ▾". */
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const menuItems = (): HTMLButtonElement[] => [
    ...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
  ];

  // Opening hands the keyboard the first item; the list is only in the tab
  // order while it is open.
  useEffect(() => {
    if (open) menuItems()[0]?.focus();
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const step = (d: number) => {
    const all = menuItems();
    if (!all.length) return;
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[Math.max(0, Math.min(all.length - 1, at + d))]?.focus();
  };

  return (
    <div
      className="menu"
      ref={rootRef}
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === "Escape") {
          e.stopPropagation();
          close(true);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          step(e.key === "ArrowDown" ? 1 : -1);
        }
      }}
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label}
      </button>
      <div className="menu-items" role="menu" aria-label={ariaLabel ?? label} data-open={open}>
        {items.map((it) => (
          <button
            key={it.label}
            role="menuitem"
            tabIndex={open ? 0 : -1}
            onClick={() => {
              close(true);
              it.onPick();
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}
