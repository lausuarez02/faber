import { useMemo, useState } from "react";
import {
  Cable,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Ellipsis,
  FileCode2,
  FlaskConical,
  Gauge,
  Hand,
  Maximize2,
  MessagesSquare,
  Moon,
  MousePointer2,
  PanelRight,
  Plus,
  Redo2,
  ScanSearch,
  SlidersHorizontal,
  SquareTerminal,
  Sun,
  SunMoon,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { useJumper } from "../lib/app.ts";
import { getDef } from "../lib/parts.ts";
import { useUi, type PanelId, type Tool } from "../lib/ui.ts";
import { PartsLibrary } from "../components/PartsLibrary.tsx";
import { MenuItem, Popover, STROKE } from "./primitives.tsx";
import { cycleTheme, fitView, focusPart, zoomIn, zoomOut } from "./actions.ts";
import { categoryIcon } from "./icons.ts";

function RailButton({
  icon: I,
  label,
  active,
  onClick,
  testId,
  popover,
  dot,
  shortcut,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick(): void;
  testId?: string;
  popover?: string;
  dot?: "warn" | "live";
  shortcut?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`rail-btn ${active ? "is-active" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
      data-testid={testId}
      data-popover-trigger={popover}
      disabled={disabled}
    >
      <I size={18} strokeWidth={STROKE} aria-hidden />
      <span className="rail-label">{label}</span>
      {dot ? <span className={`rail-dot rail-dot-${dot}`} aria-hidden /> : null}
    </button>
  );
}

/** Left: the floating vertical tool rail (a bottom bar on phones). */
export function ToolRail({ phone }: { phone: boolean }) {
  const tool = useUi((s) => s.tool);
  const panels = useUi((s) => s.panels);
  const popover = useUi((s) => s.popover);
  const expanded = useUi((s) => s.railExpanded);
  const fw = useJumper((s) => s.firmware.status);
  const hasFw = useJumper((s) => !!s.project.firmware);
  const canUndo = useJumper((s) => s.past.length > 0);
  const canRedo = useJumper((s) => s.future.length > 0);
  const ui = useUi.getState;
  const panel = (id: PanelId) => ({ active: panels.includes(id), onClick: () => ui().togglePanel(id) });
  const tools: { id: Tool; icon: LucideIcon; label: string; key: string }[] = [
    { id: "select", icon: MousePointer2, label: "Select", key: "V" },
    { id: "hand", icon: Hand, label: "Hand", key: "H" },
    { id: "wire", icon: Cable, label: "Wire", key: "W" },
  ];

  const add = (
    <div className="anchor">
      <button
        type="button"
        className={`rail-add ${popover === "parts" ? "is-open" : ""}`}
        aria-label="Add part"
        title="Add part (A)"
        data-testid="rail-add"
        data-popover-trigger="parts"
        aria-expanded={popover === "parts"}
        onClick={() => ui().togglePopover("parts")}
      >
        <Plus size={20} strokeWidth={2} aria-hidden />
      </button>
      <Popover id="parts" label="Parts library" className={phone ? "popover-sheet popover-parts" : "popover-rail popover-parts"}>
        <PartsLibrary onPlaced={() => ui().setPopover(null)} />
      </Popover>
    </div>
  );

  const jump = (
    <div className="anchor">
      <RailButton icon={ScanSearch} label="Jump to part" shortcut="/" active={popover === "jump"} popover="jump" testId="rail-jump" onClick={() => ui().togglePopover("jump")} />
      <Popover id="jump" label="Jump to part" className={phone ? "popover-sheet" : "popover-rail popover-jump"}>
        <JumpTo />
      </Popover>
    </div>
  );

  const more = (
    <div className="anchor">
      <RailButton icon={Ellipsis} label="More" active={popover === "more"} popover="more" testId="rail-more" onClick={() => ui().togglePopover("more")} />
      <Popover id="more" label="More" className={phone ? "popover-sheet popover-menu" : "popover-rail popover-rail-bottom popover-menu"}>
        <MoreMenu />
      </Popover>
    </div>
  );

  if (phone) {
    return (
      <nav className="rail rail-phone float-box" aria-label="Tools" data-testid="tool-rail">
        {add}
        <RailButton icon={Cable} label="Wire" active={tool === "wire"} onClick={() => ui().setTool(tool === "wire" ? "select" : "wire")} testId="rail-tool-wire" />
        {jump}
        <RailButton icon={Undo2} label="Undo" onClick={() => useJumper.getState().undo()} testId="dock-undo" disabled={!canUndo} />
        <RailButton icon={Redo2} label="Redo" onClick={() => useJumper.getState().redo()} testId="dock-redo" disabled={!canRedo} />
        <RailButton icon={SquareTerminal} label="Serial" {...panel("serial")} testId="rail-serial" />
        <RailButton icon={SlidersHorizontal} label="Inspect" {...panel("inspector")} testId="rail-inspect" />
        {more}
      </nav>
    );
  }

  return (
    <div className="rail-zone">
      <nav className={`rail float-box ${expanded ? "is-expanded" : ""}`} aria-label="Tools" data-testid="tool-rail">
        {add}
        <RailButton icon={FileCode2} label="Firmware" {...panel("firmware")} testId="rail-firmware" dot={hasFw && fw === "missing" ? "warn" : undefined} />
        <button type="button" className="rail-chevron" aria-label={expanded ? "Hide labels" : "Show labels"} title={expanded ? "Hide labels" : "Show labels"} onClick={() => ui().setRailExpanded(!expanded)}>
          {expanded ? <ChevronUp size={14} strokeWidth={STROKE} aria-hidden /> : <ChevronDown size={14} strokeWidth={STROKE} aria-hidden />}
        </button>
        <RailButton icon={Gauge} label="Instruments" {...panel("instruments")} testId="rail-instruments" />
        <span className="rail-sep" aria-hidden />
        {tools.map((t) => (
          <RailButton key={t.id} icon={t.icon} label={t.label} shortcut={t.key} active={tool === t.id} onClick={() => ui().setTool(t.id)} testId={`rail-tool-${t.id}`} />
        ))}
        {jump}
        <RailButton icon={MessagesSquare} label="Agent steps" {...panel("agent")} testId="rail-agent" />
        <RailButton icon={FlaskConical} label="Tests" {...panel("tests")} testId="rail-tests" />
        <span className="rail-sep" aria-hidden />
        {more}
      </nav>
    </div>
  );
}

function JumpTo() {
  const parts = useJumper((s) => s.project.parts);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return parts.filter((p) => !t || p.id.toLowerCase().includes(t) || p.type.includes(t) || (getDef(p.type)?.spec.name.toLowerCase().includes(t) ?? false));
  }, [parts, q]);
  const go = (id: string) => {
    useUi.getState().setPopover(null);
    focusPart(id);
  };
  return (
    <div className="jump" data-testid="jump-to">
      <label className="search-field">
        <ScanSearch size={15} strokeWidth={STROKE} aria-hidden />
        <input
          autoFocus
          type="search"
          placeholder="Jump to a part on the canvas"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && list[0] && go(list[0].id)}
          data-testid="jump-search"
        />
      </label>
      <ul className="jump-list" role="listbox">
        {list.length === 0 ? <li className="empty">No part on the canvas matches “{q}”.</li> : null}
        {list.map((p) => {
          const def = getDef(p.type);
          const I = categoryIcon(def?.spec.category);
          return (
            <li key={p.id}>
              <button type="button" className="menu-item" onClick={() => go(p.id)} data-testid={`jump-${p.id}`}>
                <span className="menu-item-icon">
                  <I size={16} strokeWidth={STROKE} aria-hidden />
                </span>
                <span className="menu-item-label mono">{p.id}</span>
                <span className="menu-item-hint">{def?.spec.name ?? p.type}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MoreMenu() {
  const theme = useJumper((s) => s.theme);
  const canUndo = useJumper((s) => s.past.length > 0);
  const canRedo = useJumper((s) => s.future.length > 0);
  const ui = useUi.getState;
  const run = (fn: () => void) => () => {
    ui().setPopover(null);
    fn();
  };
  return (
    <div role="menu">
      <MenuItem icon={Undo2} hint="⌘Z" disabled={!canUndo} onSelect={() => useJumper.getState().undo()} testId="menu-undo">
        Undo
      </MenuItem>
      <MenuItem icon={Redo2} hint="⇧⌘Z" disabled={!canRedo} onSelect={() => useJumper.getState().redo()} testId="menu-redo">
        Redo
      </MenuItem>
      <div className="menu-sep" />
      <MenuItem icon={Maximize2} hint="⇧1" onSelect={run(() => fitView())} testId="menu-fit">
        Fit view
      </MenuItem>
      <MenuItem icon={ZoomIn} hint="+" onSelect={zoomIn}>
        Zoom in
      </MenuItem>
      <MenuItem icon={ZoomOut} hint="−" onSelect={zoomOut}>
        Zoom out
      </MenuItem>
      <div className="menu-sep" />
      <MenuItem icon={PanelRight} hint="I" onSelect={run(() => ui().togglePanel("inspector"))}>
        Inspector
      </MenuItem>
      <MenuItem icon={Gauge} onSelect={run(() => ui().togglePanel("instruments"))}>
        Instruments
      </MenuItem>
      <MenuItem icon={FileCode2} onSelect={run(() => ui().togglePanel("firmware"))}>
        Firmware
      </MenuItem>
      <MenuItem icon={CircleHelp} hint="?" onSelect={run(() => ui().togglePanel("help"))}>
        Keyboard shortcuts
      </MenuItem>
      <MenuItem icon={theme === "light" ? Sun : theme === "dark" ? Moon : SunMoon} hint={theme} onSelect={cycleTheme}>
        Theme
      </MenuItem>
    </div>
  );
}
