import { agentLabel, useAgentState } from "../live/agentState.ts";
import "./connect.css";

const FACE = [1, 2, 3, 5, 9, 11, 13, 15, 19, 21, 22, 23];

/**
 * The dot-matrix avatar bottom-right, driven by the one agent state (C6): dim with no agent (none,
 * or done), lit when one is idle with its session open, pulsing while it builds. The text lives in
 * the agent pill next to it.
 */
export function AgentPresence() {
  const s = useAgentState();
  const state = s.status === "building" ? "busy" : s.status === "idle" ? "on" : "off";
  const label = agentLabel(s);
  const lit = state !== "off";
  return (
    <span className={`agent-avatar cx-presence is-${state}`} data-testid="agent-presence" data-agent-state={state} data-agent-status={s.status} title={s.current?.why ? `${label}: ${s.current.why}` : label} aria-label={label} role="status">
      <svg width="20" height="20" viewBox="0 0 25 25" aria-hidden="true">
        {Array.from({ length: 25 }, (_, i) => (
          <circle
            key={i}
            className={FACE.includes(i) ? "cx-face" : undefined}
            style={{ animationDelay: `${(i % 5) * 90 + Math.floor(i / 5) * 60}ms` }}
            cx={2.5 + (i % 5) * 5}
            cy={2.5 + Math.floor(i / 5) * 5}
            r={1.5}
            fill="currentColor"
            opacity={FACE.includes(i) ? (lit ? 0.95 : 0.9) : lit ? 0.15 : 0.18}
          />
        ))}
      </svg>
    </span>
  );
}
