import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { engine, loadInitialFirmware, useJumper } from "./lib/app.ts";
import { partDefinitions } from "./lib/parts.ts";
import { useIsPhone, useUi } from "./lib/ui.ts";
import { Canvas } from "./components/Canvas.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { EmptyHint } from "./components/EmptyHint.tsx";
import { LiveLayer } from "./live/LiveLayer.tsx";
import { useLive } from "./live/liveStore.ts";
import { TitleBlock } from "./shell/TitleBlock.tsx";
import { PhoneTopActions, TopActions } from "./shell/TopActions.tsx";
import { ToolRail } from "./shell/ToolRail.tsx";
import { BottomLeft, BottomRight } from "./shell/Corners.tsx";
import { PanelColumn, useAutoInspector } from "./shell/Panels.tsx";
import { fitView, zoomIn, zoomOut } from "./shell/actions.ts";
import { DeviceView } from "./views/device/DeviceView.tsx";
import { ChromeSlots, StageSlots } from "./shell/slots.tsx";

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest("input, textarea, select, [contenteditable=true]") !== null) return;
      const mod = e.metaKey || e.ctrlKey;
      const s = useJumper.getState();
      const ui = useUi.getState();
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        s.redo();
      } else if (mod && key === "k") {
        e.preventDefault();
        ui.togglePopover("jump");
      } else if (mod || e.altKey) {
        return;
      } else if (key === "escape") {
        if (ui.popover) ui.setPopover(null);
        else if (ui.device) ui.setDevice(false);
        else if (s.selectedParts.length || s.selectedWires.length) s.select([], []);
      } else if (key === "r") {
        s.rotateSelected();
      } else if (key === "c" && s.selectedWires.length) {
        for (const w of s.selectedWires) useJumper.getState().cycleWireColor(w);
      } else if (key === " " && t?.tagName !== "BUTTON") {
        e.preventDefault();
        if (s.run === "running") engine.pause();
        else engine.run();
      } else if (key === "v") ui.setTool("select");
      else if (key === "h") ui.setTool("hand");
      else if (key === "w") ui.setTool("wire");
      else if (key === "a") ui.togglePopover("parts");
      else if (key === "/") {
        e.preventDefault();
        ui.togglePopover("jump");
      } else if (key === "i") ui.togglePanel("inspector");
      else if (key === "`") ui.togglePanel("serial");
      else if (e.key === "?") ui.togglePanel("help");
      else if (e.key === "!" && e.shiftKey) fitView();
      else if (e.key === "+" || e.key === "=") zoomIn();
      else if (e.key === "-") zoomOut();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function useTheme() {
  const theme = useJumper((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    const bg = getComputedStyle(root).getPropertyValue("--bg-canvas").trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg || "#0A0A0A");
  }, [theme]);
}

/**
 * Keep the circuit clear of the floating chrome: fit again when the first panel opens by hand,
 * when the last one closes, and when the robot's World card appears.
 */
function useRefitOnChrome() {
  useEffect(() => {
    let hadWorld = !!engine.getWorld();
    const offWorld = engine.subscribeWorld(() => {
      const has = !!engine.getWorld();
      if (has !== hadWorld) requestAnimationFrame(() => fitView(400));
      hadWorld = has;
    });
    let hadNet = !!engine.getNetwork();
    const offNet = engine.subscribeNetwork(() => {
      const has = !!engine.getNetwork();
      if (has !== hadNet) requestAnimationFrame(() => fitView(400));
      hadNet = has;
    });
    const offUi = useUi.subscribe((s, prev) => {
      const opened = prev.panels.length === 0 && s.panels.length > 0 && !s.inspectorAuto;
      const closed = prev.panels.length > 0 && s.panels.length === 0 && !prev.inspectorAuto;
      if ((opened || closed) && !useLive.getState().mode.startsWith("f")) requestAnimationFrame(() => fitView(350));
    });
    return () => {
      offNet();
      offWorld();
      offUi();
    };
  }, []);
}

/**
 * The v2 shell: a full-bleed canvas and a few floating controls (docs/design/ui-v2.md).
 * Top-left title, top-right actions, left tool rail, right panel column, bottom-left minimap and
 * status, bottom-right agent pill. On phones the rail becomes a bottom bar and panels bottom sheets.
 */
export function App() {
  useKeyboard();
  useTheme();
  const phone = useIsPhone();
  useAutoInspector(phone);
  const firmware = useJumper((s) => s.firmware.status);
  const tool = useUi((s) => s.tool);
  const panelCount = useUi((s) => s.panels.length);
  const device = useUi((s) => s.device);
  const live = useLive((s) => s.mode);

  useEffect(() => {
    void loadInitialFirmware();
  }, []);
  useRefitOnChrome();

  return (
    <ReactFlowProvider>
      <div
        className="app"
        data-testid="app"
        data-firmware={firmware}
        data-registry-count={partDefinitions.length}
        data-tool={tool}
        data-panels={panelCount}
        data-live={live}
        data-layout={phone ? "phone" : "desktop"}
      >
        <main className="stage">
          <Canvas />
          <LiveLayer />
          <EmptyHint />
          <StageSlots />
        </main>
        <header className="chrome-top">
          <TitleBlock />
          {phone ? <PhoneTopActions /> : <TopActions />}
        </header>
        <ToolRail phone={phone} />
        <PanelColumn />
        <BottomLeft phone={phone} />
        {phone ? null : <BottomRight />}
        {device ? (
          <div className="device-layer">
            <DeviceView onClose={() => useUi.getState().setDevice(false)} />
          </div>
        ) : null}
        <ChromeSlots />
        <Toasts />
      </div>
    </ReactFlowProvider>
  );
}
