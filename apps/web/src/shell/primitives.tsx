import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";
import { useUi, type PanelId, type PopoverId } from "../lib/ui.ts";

/** Lucide stroke used everywhere: thin line icons. */
export const STROKE = 1.6;

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean; size?: number; iconSize?: number };

/** A ghost icon button (tooltip = label). */
export function IconButton({ icon: I, label, active, className = "", size, iconSize = 18, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? "is-active" : ""} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      style={size ? { width: size, height: size } : undefined}
      {...rest}
    >
      <I size={iconSize} strokeWidth={STROKE} aria-hidden />
    </button>
  );
}

/**
 * A popover anchored inside its (position: relative) wrapper. Closes on outside pointer-down and
 * Escape. `id` is the slot in the UI store so only one popover is open at a time.
 */
export function Popover({ id, className = "", children, label }: { id: Exclude<PopoverId, null>; className?: string; children: ReactNode; label: string }) {
  const open = useUi((s) => s.popover === id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t)) return;
      // The trigger toggles itself; leave clicks on it alone.
      if (t.closest(`[data-popover-trigger="${id}"]`)) return;
      useUi.getState().setPopover(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useUi.getState().setPopover(null);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, id]);
  if (!open) return null;
  return (
    <div ref={ref} className={`popover ${className}`} role="dialog" aria-label={label} data-popover={id}>
      {children}
    </div>
  );
}

/** A floating panel: rounded card with a title row and a close button. */
export function FloatingPanel({
  id,
  title,
  icon: I,
  actions,
  children,
  className = "",
  testId,
}: {
  id: PanelId;
  title: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`float-panel panel-${id} ${className}`} aria-label={typeof title === "string" ? title : id} data-testid={testId ?? `panel-${id}`}>
      <header className="float-panel-head">
        {I ? <I size={15} strokeWidth={STROKE} aria-hidden className="float-panel-icon" /> : null}
        <span className="float-panel-title">{title}</span>
        <span className="float-panel-actions">
          {actions}
          <IconButton icon={X} label={`Close ${typeof title === "string" ? title : "panel"}`} iconSize={15} className="icon-btn-sm" onClick={() => useUi.getState().closePanel(id)} />
        </span>
      </header>
      <div className="float-panel-body">{children}</div>
    </section>
  );
}

/** A menu row (icon + label + optional hint on the right). */
export function MenuItem({
  icon: I,
  children,
  hint,
  onSelect,
  disabled,
  testId,
  danger,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  hint?: ReactNode;
  onSelect(): void;
  disabled?: boolean;
  testId?: string;
  danger?: boolean;
}) {
  return (
    <button type="button" role="menuitem" className={`menu-item ${danger ? "is-danger" : ""}`} disabled={disabled} onClick={onSelect} data-testid={testId}>
      <span className="menu-item-icon">{I ? <I size={16} strokeWidth={STROKE} aria-hidden /> : null}</span>
      <span className="menu-item-label">{children}</span>
      {hint ? <span className="menu-item-hint">{hint}</span> : null}
    </button>
  );
}
