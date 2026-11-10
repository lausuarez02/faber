import { Bot, Box, ChevronDown, Ellipsis, FlaskConical, GraduationCap, CircleHelp, Pause, Play, Plug, Presentation, RotateCcw, SquareTerminal, Moon, Sun, SunMoon } from "lucide-react";
import { engine, useJumper } from "../lib/app.ts";
import { RELIABLE_SPEED, SPEEDS } from "../lib/store.ts";
import { useUi } from "../lib/ui.ts";
import { useLive } from "../live/liveStore.ts";
import { useCase } from "../case/store.ts"; // round 6 case
import { InstallMcpMenu } from "../connect/InstallMcpMenu.tsx";
import { OpenInAgentMenu } from "../connect/OpenInAgentMenu.tsx";
import { IconButton, MenuItem, Popover, STROKE } from "./primitives.tsx";
import { cycleTheme } from "./actions.ts";

/** Top-right: one floating container with the panel toggles, the agent dropdowns and the Run pill. */
export function TopActions() {
  const panels = useUi((s) => s.panels);
  const popover = useUi((s) => s.popover);
  const device = useUi((s) => s.device);
  const ui = useUi.getState;
  const close = () => ui().setPopover(null);

  return (
    <div className="top-actions float-box" data-testid="top-actions">
      <div className="top-actions-icons">
        <IconButton icon={SquareTerminal} label="Serial console" active={panels.includes("serial")} onClick={() => ui().togglePanel("serial")} data-testid="toggle-serial" />
        <IconButton icon={FlaskConical} label="Tests" active={panels.includes("tests")} onClick={() => ui().togglePanel("tests")} data-testid="toggle-tests" />
        <IconButton icon={Presentation} label="Device view" active={device} onClick={() => ui().setDevice(!device)} data-testid="toggle-device" />
        <IconButton icon={Box} label="Case: printable enclosure and factory files" onClick={() => useCase.getState().setOpen(true)} data-testid="toggle-case" /> {/* round 6 case */}
      </div>
      <span className="vsep" aria-hidden />
      <div className="anchor">
        <button
          type="button"
          className={`btn-outline ${popover === "mcp" ? "is-open" : ""}`}
          aria-expanded={popover === "mcp"}
          data-popover-trigger="mcp"
          data-testid="install-mcp"
          onClick={() => ui().togglePopover("mcp")}
        >
          <Plug size={16} strokeWidth={STROKE} aria-hidden />
          <span>Install MCP</span>
          <ChevronDown size={14} strokeWidth={STROKE} aria-hidden className="chev" />
        </button>
        <Popover id="mcp" label="Install MCP" className="popover-below-right popover-wide">
          <InstallMcpMenu onClose={close} />
        </Popover>
      </div>
      <div className="anchor">
        <button
          type="button"
          className={`btn-outline ${popover === "agent-menu" ? "is-open" : ""}`}
          aria-expanded={popover === "agent-menu"}
          data-popover-trigger="agent-menu"
          data-testid="open-in-agent"
          onClick={() => ui().togglePopover("agent-menu")}
        >
          <Bot size={16} strokeWidth={STROKE} aria-hidden />
          <span>Open in Agent</span>
          <ChevronDown size={14} strokeWidth={STROKE} aria-hidden className="chev" />
        </button>
        <Popover id="agent-menu" label="Open in Agent" className="popover-below-right popover-wide">
          <OpenInAgentMenu onClose={close} />
        </Popover>
      </div>
      <IconButton icon={RotateCcw} label="Reset simulation" className="reset-btn" onClick={() => engine.reset()} data-testid="reset-button" />
      <RunPill />
    </div>
  );
}

/** The single primary action: Run / Pause, with the speed as a split segment. */
export function RunPill({ compact = false }: { compact?: boolean }) {
  const run = useJumper((s) => s.run);
  const speed = useJumper((s) => s.speed);
  const mode = useLive((s) => s.mode);
  // Replays show a recorded session; a followed page runs the project here (round 5).
  const external = mode === "replay";
  const running = run === "running";
  return (
    <div className={`run-pill ${running ? "is-running" : ""}`}>
      <button
        type="button"
        className="run-pill-main"
        data-testid="run-button"
        aria-label={running ? "Pause simulation" : "Run simulation"}
        title={external ? "A replay shows a recorded session; open the project to run it" : mode === "follow" && !running ? "Run here with the agent's latest firmware (Space)" : running ? "Pause (Space)" : "Run (Space)"}
        disabled={external}
        onClick={() => (running ? engine.pause() : engine.run())}
      >
        {running ? <Pause size={15} strokeWidth={2} fill="currentColor" aria-hidden /> : <Play size={15} strokeWidth={2} fill="currentColor" aria-hidden />}
        <span>{running ? "Pause" : "Run"}</span>
      </button>
      {compact ? null : (
        <label className="run-pill-speed" title={`Simulation speed. Up to ${RELIABLE_SPEED}× holds steady; above that is best effort (the status pill shows the real factor).`}>
          <span className="sr-only">Speed</span>
          <select data-testid="speed-select" value={speed} disabled={external} onChange={(e) => useJumper.getState().setSpeed(Number(e.target.value))}>
            {SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v}×{v > RELIABLE_SPEED ? " max" : ""}
              </option>
            ))}
          </select>
          <ChevronDown size={13} strokeWidth={2} aria-hidden />
        </label>
      )}
    </div>
  );
}

/** Phones: the top-right collapses to the Run pill and a "⋯" menu with everything else. */
export function PhoneTopActions() {
  const ui = useUi.getState;
  const theme = useJumper((s) => s.theme);
  const close = () => ui().setPopover(null);
  const openPanel = (id: Parameters<ReturnType<typeof ui>["openPanel"]>[0]) => {
    close();
    ui().openPanel(id);
  };
  return (
    <div className="phone-top">
      <RunPill compact />
      <div className="anchor">
        <button
          type="button"
          className="icon-btn phone-more float-box"
          aria-label="More"
          data-testid="phone-menu"
          data-popover-trigger="phone-menu"
          onClick={() => ui().togglePopover("phone-menu")}
        >
          <Ellipsis size={18} strokeWidth={STROKE} aria-hidden />
        </button>
        <Popover id="phone-menu" label="More" className="popover-menu popover-below-right">
          <div role="menu">
            <MenuItem icon={SquareTerminal} onSelect={() => openPanel("serial")} testId="phone-serial">
              Serial console
            </MenuItem>
            <MenuItem icon={FlaskConical} onSelect={() => openPanel("tests")} testId="phone-tests">
              Tests
            </MenuItem>
            <MenuItem icon={Presentation} onSelect={() => ui().setDevice(true)} testId="phone-device">
              Device view
            </MenuItem>
            <MenuItem icon={Box} onSelect={() => (close(), useCase.getState().setOpen(true))} testId="phone-case">
              Case {/* round 6 case */}
            </MenuItem>
            <div className="menu-sep" />
            <MenuItem icon={Plug} onSelect={() => ui().setPopover("mcp")} testId="phone-install-mcp">
              Install MCP
            </MenuItem>
            <MenuItem icon={Bot} onSelect={() => ui().setPopover("agent-menu")}>
              Open in Agent
            </MenuItem>
            <div className="menu-sep" />
            <MenuItem icon={RotateCcw} onSelect={() => (engine.reset(), close())}>
              Reset simulation
            </MenuItem>
            <MenuItem icon={theme === "light" ? Sun : theme === "dark" ? Moon : SunMoon} onSelect={cycleTheme} hint={theme}>
              Theme
            </MenuItem>
            <MenuItem icon={CircleHelp} onSelect={() => openPanel("help")}>
              Shortcuts
            </MenuItem>
            <MenuItem icon={GraduationCap} onSelect={() => openPanel("learn")}>
              Learn
            </MenuItem>
          </div>
        </Popover>
        {/* The agent dropdowns open as sheets on phones. */}
        <Popover id="mcp" label="Install MCP" className="popover-sheet">
          <InstallMcpMenu onClose={close} />
        </Popover>
        <Popover id="agent-menu" label="Open in Agent" className="popover-sheet">
          <OpenInAgentMenu onClose={close} />
        </Popover>
      </div>
    </div>
  );
}
