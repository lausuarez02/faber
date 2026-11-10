import { useCallback } from "react";
import { Activity, ChevronRight, Plug, CircleHelp, GraduationCap, Moon, Sun, SunMoon } from "lucide-react";
import { engine, useJumper } from "../lib/app.ts";
import { useUi } from "../lib/ui.ts";
import { useAgentSteps, useLive } from "../live/liveStore.ts";
import { AgentPresence } from "../connect/AgentPresence.tsx";
import { agentLabel, useAgentState } from "../live/agentState.ts";
import { STROKE } from "./primitives.tsx";
import { cycleTheme } from "./actions.ts";

/** Bottom-left: round buttons (theme, shortcuts, learn) and the simulation status pill. The minimap sits above (Canvas). */
export function BottomLeft({ phone }: { phone: boolean }) {
  const theme = useJumper((s) => s.theme);
  const ui = useUi.getState;
  return (
    <div className="bottom-left">
      {phone ? null : (
        <>
          <button type="button" className="round-btn" data-testid="theme-toggle" aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`} onClick={cycleTheme}>
            {theme === "light" ? <Sun size={18} strokeWidth={STROKE} aria-hidden /> : theme === "dark" ? <Moon size={18} strokeWidth={STROKE} aria-hidden /> : <SunMoon size={18} strokeWidth={STROKE} aria-hidden />}
          </button>
          <button type="button" className="round-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => ui().togglePanel("help")} data-testid="help-button">
            <CircleHelp size={18} strokeWidth={STROKE} aria-hidden />
          </button>
          <button type="button" className="round-btn" aria-label="Learn Jumper" title="Learn Jumper" onClick={() => ui().togglePanel("learn")} data-testid="learn-button">
            <GraduationCap size={18} strokeWidth={STROKE} aria-hidden />
          </button>
        </>
      )}
      <StatusPill />
    </div>
  );
}

/** "● 00:13.500 | 1.00× rt": green while running, gray when stopped. Virtual time, not wall clock. */
function StatusPill() {
  const run = useJumper((s) => s.run);
  const factor = useJumper((s) => s.factor);
  const live = useLive((s) => s.mode !== "off");
  const replay = useLive((s) => s.replay);
  // The engine writes the clock straight into this span every frame; React stays out of the frame loop.
  const clockRef = useCallback((el: HTMLSpanElement | null) => engine.registerClock(el), []);
  const running = run === "running" || (live && replay.playing);
  return (
    <div className={`status-pill ${running ? "is-running" : ""}`} data-testid="sim-time" data-run={run} title="Virtual time (MCU cycles), not wall clock">
      <Activity size={15} strokeWidth={2} aria-hidden className="status-icon" />
      <span className="status-clock mono" data-testid="sim-clock" ref={clockRef} />
      <span className="status-div" aria-hidden />
      <span className="status-factor mono" data-testid="sim-factor">
        {run === "running" ? (
          factor > 0 ? (
            <>
              {factor.toFixed(2)}× <abbr title="real time">rt</abbr>
            </>
          ) : (
            "measuring"
          )
        ) : run === "paused" ? (
          "paused"
        ) : (
          "stopped"
        )}
      </span>
    </div>
  );
}

/**
 * Bottom-right: the agent pill (opens the steps panel) and the presence avatar. Both read the one
 * agent state (C6): "No agent" in grey with Connect until an MCP client has called a tool, then
 * "building", "idle" or "done". Replays show their position instead.
 */
export function BottomRight() {
  const mode = useLive((s) => s.mode);
  const steps = useAgentSteps(); // round 6 switch: the person's own edits are not "to review"
  const replay = useLive((s) => s.replay);
  const agent = useAgentState();
  const open = useUi((s) => s.panels.includes("agent"));
  const pending = steps.filter((s) => s.status === "pending").length;
  const none = mode !== "replay" && agent.status === "none";
  const status =
    mode === "replay"
      ? `replay · ${replay.index}/${replay.total}`
      : none
        ? "No agent"
        : `${agentLabel(agent).replace(/^(.*?) (building|idle|done)/, "$2")}${pending ? ` · ${pending} to review` : ""}`;
  return (
    <div className="bottom-right">
      {none ? (
        <button type="button" className="agent-connect" data-testid="agent-connect" onClick={() => useUi.getState().setPopover("mcp")} title="Connect Claude Code, Codex or another MCP agent">
          <Plug size={14} strokeWidth={STROKE} aria-hidden />
          Connect
        </button>
      ) : null}
      <button type="button" className={`agent-pill ${open ? "is-open" : ""}`} onClick={() => useUi.getState().togglePanel("agent")} data-testid="agent-pill" data-agent-status={mode === "replay" ? "replay" : agent.status} aria-expanded={open} title={mode === "replay" ? undefined : agentLabel(agent)}>
        <span className="agent-pill-label">{mode !== "replay" && agent.agent && !none ? agent.agent : "Agent"}</span>
        <span className={`agent-pill-status is-${mode === "replay" ? "live" : agent.status} ${mode === "replay" || agent.status === "building" ? "is-live" : ""}`}>{status}</span>
        <ChevronRight size={15} strokeWidth={STROKE} aria-hidden />
      </button>
      <AgentPresence />
    </div>
  );
}
