import { useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { engine, loadInitialFirmware, useJumper } from "./lib/app.ts";
import { partDefinitions } from "./lib/parts.ts";
import { TopBar } from "./components/TopBar.tsx";
import { PartsLibrary } from "./components/PartsLibrary.tsx";
import { Canvas } from "./components/Canvas.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { SerialConsole } from "./components/SerialConsole.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { Icon } from "./components/Icon.tsx";
import { LiveLayer } from "./live/LiveLayer.tsx";
import { WorldPanel } from "./components/WorldPanel.tsx";

type Sheet = "parts" | "inspect" | "serial" | null;

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") !== null)) return;
      const mod = e.metaKey || e.ctrlKey;
      const s = useJumper.getState();
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        s.redo();
      } else if (!mod && key === "r") {
        s.rotateSelected();
      } else if (!mod && key === "c" && s.selectedWires.length) {
        for (const w of s.selectedWires) useJumper.getState().cycleWireColor(w);
      } else if (!mod && key === " " && t?.tagName !== "BUTTON") {
        e.preventDefault();
        if (s.run === "running") engine.pause();
        else engine.run();
      }
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
    const bg = getComputedStyle(root).getPropertyValue("--ink").trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg || "#0D0F12");
  }, [theme]);
}

export function App() {
  useKeyboard();
  useTheme();
  const [sheet, setSheet] = useState<Sheet>(null);
  const firmware = useJumper((s) => s.firmware.status);
  const selected = useJumper((s) => s.selectedParts.length + s.selectedWires.length);
  const canUndo = useJumper((s) => s.past.length > 0);
  const canRedo = useJumper((s) => s.future.length > 0);

  useEffect(() => {
    void loadInitialFirmware();
  }, []);

  const toggle = (k: Exclude<Sheet, null>) => setSheet((cur) => (cur === k ? null : k));

  return (
    <ReactFlowProvider>
      <div
        className="app"
        data-testid="app"
        data-sheet={sheet ?? "none"}
        data-firmware={firmware}
        data-registry-count={partDefinitions.length}
      >
        <TopBar />
        <div className="workspace">
          <div className="side side-left">
            <PartsLibrary onPlaced={() => setSheet(null)} />
          </div>
          <main className="stage">
            <Canvas />
            <WorldPanel />
            <LiveLayer />
          </main>
          <div className="side side-right">
            <Inspector />
            <SerialConsole />
          </div>
        </div>
        <nav className="dock" aria-label="Panels">
          <button className={sheet === "parts" ? "on" : ""} onClick={() => toggle("parts")} data-testid="dock-parts">
            <Icon name="parts" /> Parts
          </button>
          <button className={sheet === "inspect" ? "on" : ""} onClick={() => toggle("inspect")} data-testid="dock-inspect">
            <Icon name="sliders" /> Inspect{selected ? <span className="dock-count">{selected}</span> : null}
          </button>
          <button className={sheet === "serial" ? "on" : ""} onClick={() => toggle("serial")} data-testid="dock-serial">
            <Icon name="terminal" /> Serial
          </button>
          {/* Phones have no keyboard and no room for these in the top bar, so they live here. */}
          <button className="dock-icon" aria-label="Undo" data-testid="dock-undo" disabled={!canUndo} onClick={() => useJumper.getState().undo()}>
            <Icon name="undo" />
          </button>
          <button className="dock-icon" aria-label="Redo" data-testid="dock-redo" disabled={!canRedo} onClick={() => useJumper.getState().redo()}>
            <Icon name="redo" />
          </button>
        </nav>
        <Toasts />
      </div>
    </ReactFlowProvider>
  );
}
