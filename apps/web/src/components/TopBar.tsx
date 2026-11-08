import { useCallback, useRef, useState, type ChangeEvent } from "react";
import { safeParseProject, serializeProject } from "@jumper/project-format";
import { engine, useJumper } from "../lib/app.ts";
import { RELIABLE_SPEED, SPEEDS, type ThemeChoice } from "../lib/store.ts";
import { Wordmark } from "./Logo.tsx";
import { Icon } from "./Icon.tsx";

const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = { system: "dark", dark: "light", light: "system" };

export function TopBar() {
  const name = useJumper((s) => s.project.name);
  const run = useJumper((s) => s.run);
  const speed = useJumper((s) => s.speed);
  const factor = useJumper((s) => s.factor);
  const theme = useJumper((s) => s.theme);
  const firmware = useJumper((s) => s.firmware);
  const canUndo = useJumper((s) => s.past.length > 0);
  const canRedo = useJumper((s) => s.future.length > 0);
  const [menu, setMenu] = useState(false);
  // The engine writes the virtual clock straight into this span every frame; React stays out of the frame loop.
  const clockRef = useCallback((el: HTMLSpanElement | null) => engine.registerClock(el), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const hexRef = useRef<HTMLInputElement>(null);

  const running = run === "running";

  const download = () => {
    const p = useJumper.getState().project;
    const blob = new Blob([serializeProject(p)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.name.replace(/[^\w.-]+/g, "-").toLowerCase() || "project"}.jumper.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setMenu(false);
  };

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    setMenu(false);
    if (!file) return;
    const res = safeParseProject(await file.text());
    const s = useJumper.getState();
    if (!res.ok) {
      s.toast({
        kind: "error",
        title: `${file.name} is not a valid jumper.json`,
        detail: res.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("\n"),
      });
      return;
    }
    engine.stop();
    s.loadProject(res.project);
    const fw = s.firmware;
    if (res.project.firmware && !(fw.status === "ready" && fw.source === "upload")) {
      s.setFirmware({ status: "missing", reason: `load ${res.project.firmware.artifact} with “Load firmware .hex”` });
    }
    s.toast({ kind: "info", title: `Opened ${res.project.name}` });
  };

  const uploadHex = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    setMenu(false);
    if (!file) return;
    const hex = await file.text();
    const s = useJumper.getState();
    if (!hex.trim().startsWith(":")) {
      s.toast({ kind: "error", title: `${file.name} is not Intel HEX`, detail: "Expected lines starting with ':' (arduino-cli writes <sketch>.ino.hex)." });
      return;
    }
    engine.stop();
    s.setFirmware({ status: "ready", hex, name: file.name, source: "upload" });
    s.setSimError(undefined);
    s.toast({ kind: "info", title: `Firmware ${file.name} loaded` });
  };

  return (
    <header className="topbar">
      <Wordmark />
      <div className="topbar-project">
        <input
          className="project-name"
          aria-label="Project name"
          defaultValue={name}
          key={name}
          onBlur={(e) => useJumper.getState().rename(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <FirmwareBadge />
      </div>

      <div className="topbar-sim">
        <button
          className={`btn btn-run ${running ? "is-running" : ""}`}
          data-testid="run-button"
          aria-label={running ? "Pause simulation" : "Run simulation"}
          onClick={() => (running ? engine.pause() : engine.run())}
        >
          <Icon name={running ? "pause" : "play"} />
          <span className="btn-label">{running ? "Pause" : "Run"}</span>
        </button>
        <button className="btn btn-icon" data-testid="reset-button" aria-label="Reset simulation" title="Reset to t = 0" onClick={() => engine.reset()}>
          <Icon name="reset" />
        </button>
        <label className="speed" title={`Simulation speed. Up to ${RELIABLE_SPEED}× holds steady; above that is best effort, as fast as this browser can run it (the clock shows the real factor).`}>
          <span className="sr-only">Speed</span>
          <select data-testid="speed-select" value={speed} onChange={(e) => useJumper.getState().setSpeed(Number(e.target.value))}>
            {SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v}×{v > RELIABLE_SPEED ? " max" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="clock" data-testid="sim-time" data-run={run} title="Virtual time (MCU cycles), not wall clock">
          <span className={`clock-dot ${running ? "on" : ""}`} />
          <span className="clock-t" data-testid="sim-clock" ref={clockRef} />
          <span className="sr-only">, </span>
          <span className="clock-x" data-testid="sim-factor">
            {running ? (
              factor > 0 ? (
                <>
                  {factor.toFixed(2)}× <abbr title="real time">rt</abbr>
                </>
              ) : (
                "measuring speed"
              )
            ) : run === "paused" ? (
              "paused"
            ) : (
              "stopped"
            )}
          </span>
        </div>
      </div>

      <div className="topbar-actions">
        <button className="btn btn-icon" aria-label="Undo" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => useJumper.getState().undo()}>
          <Icon name="undo" />
        </button>
        <button className="btn btn-icon" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => useJumper.getState().redo()}>
          <Icon name="redo" />
        </button>
        <button
          className="btn btn-icon"
          data-testid="theme-toggle"
          aria-label={`Theme: ${theme}`}
          title={`Theme: ${theme}`}
          onClick={() => useJumper.getState().setTheme(THEME_NEXT[theme])}
        >
          <Icon name={theme === "light" ? "sun" : theme === "dark" ? "moon" : "auto"} />
        </button>
        <div className="menu-wrap">
          <button className="btn btn-icon" aria-label="Project menu" aria-expanded={menu} data-testid="project-menu" onClick={() => setMenu((m) => !m)}>
            <Icon name="more" />
          </button>
          {menu && (
            <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" onClick={download} data-testid="export-project">
                <Icon name="download" /> Export jumper.json
              </button>
              <button role="menuitem" onClick={() => fileRef.current?.click()} data-testid="import-project">
                <Icon name="upload" /> Open jumper.json…
              </button>
              <button role="menuitem" onClick={() => hexRef.current?.click()}>
                <Icon name="chip" /> Load firmware .hex…
              </button>
              <div className="menu-note mono">
                firmware: {firmware.status === "ready" ? firmware.name : firmware.status}
              </div>
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={upload} data-testid="import-input" />
        <input ref={hexRef} type="file" accept=".hex,text/plain" hidden onChange={uploadHex} />
      </div>
    </header>
  );
}

function FirmwareBadge() {
  const fw = useJumper((s) => s.firmware);
  const hasFw = useJumper((s) => !!s.project.firmware);
  if (!hasFw) return null;
  const label =
    fw.status === "ready" ? fw.name.split("/").pop() : fw.status === "loading" ? "loading firmware" : "firmware not built";
  return (
    <span
      className={`badge badge-${fw.status}`}
      data-testid="firmware-status"
      data-status={fw.status}
      title={fw.status === "missing" ? fw.reason : fw.status === "ready" ? fw.name : undefined}
    >
      <Icon name="chip" />
      {label}
    </span>
  );
}
