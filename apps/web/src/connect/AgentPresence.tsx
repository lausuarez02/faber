import { useEffect, useState } from "react";
import { busyText, usePresence, type AgentInfo } from "./client.ts";
import "./connect.css";

const FACE = [1, 2, 3, 5, 9, 11, 13, 15, 19, 21, 22, 23];

/** Most tool calls take milliseconds: keep "building" up this long after the last one so a person sees it. */
const LINGER_MS = 2500;

/**
 * The dot-matrix avatar bottom-right, live: dim when no agent is attached; lit with
 * "Connected: Claude Code" when one is; the dots pulse and the label says
 * "Claude Code building · place part led1" while a tool call runs.
 */
export function AgentPresence() {
  const live = usePresence();
  const [now, setNow] = useState(() => Date.now());
  const recent = (a: AgentInfo) => !!a.last && now - Date.parse(a.last.at) < LINGER_MS;
  useEffect(() => {
    setNow(Date.now());
    if (!live.some((a) => a.last)) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [live]);
  // A just-finished call still reads as "building · <that call>".
  const agents = live.map((a) => (!a.busy && recent(a) ? { ...a, busy: { op: a.last!.op, ...(a.last!.target ? { target: a.last!.target } : {}), since: a.last!.at } } : a));
  const busy = agents.find((a) => a.busy);
  const main = busy ?? agents[0];
  const names = agents.map((a) => a.name).join(", ");
  const label = !main ? "No agent attached" : busy ? `${busy.name} building · ${busyText(busy)}` : `Connected: ${names}`;
  const state = !main ? "off" : busy ? "busy" : "on";
  return (
    <span className={`agent-avatar cx-presence is-${state}`} data-testid="agent-presence" data-agent-state={state} title={busy?.busy?.why ? `${label}: ${busy.busy.why}` : label} aria-label={label} role="status">
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
            opacity={FACE.includes(i) ? (main ? 0.95 : 0.9) : main ? 0.15 : 0.18}
          />
        ))}
      </svg>
      {main ? (
        <span className="cx-presence-label" data-testid="agent-presence-label">
          {busy ? (
            <>
              <b>{busy.name}</b> building · {busyText(busy)}
            </>
          ) : (
            <>
              Connected: <b>{names}</b>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}
