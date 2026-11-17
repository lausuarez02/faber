import { useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { copyText, useConnectInfo, type InstallSnippet } from "./client.ts";
import { agentLabel, useAgentList, useAgentState } from "../live/agentState.ts";
import "./connect.css";

const STROKE = 1.6;

/** Install commands for when no server answers: how to start one, then the same snippets. */
function offlineSnippets(base: string): InstallSnippet[] {
  const mcp = `${base}/mcp`;
  return [
    { id: "start", label: "Start Fabwright", where: "a terminal, in the Fabwright repo", kind: "command", text: "pnpm start", note: `Starts the canvas, the live link and MCP at ${mcp}.` },
    { id: "claude-code", label: "Claude Code", where: "a terminal", kind: "command", text: `claude mcp add --transport http fabwright ${mcp}` },
    { id: "codex", label: "Codex", where: "~/.codex/config.toml", kind: "toml", text: `[mcp_servers.fabwright]\nurl = "${mcp}"` },
    { id: "cursor", label: "Cursor", where: "~/.cursor/mcp.json", kind: "json", text: JSON.stringify({ mcpServers: { fabwright: { url: mcp } } }, null, 2) },
  ];
}

export function CopyBlock({ text, testId, label = "Copy", caption }: { text: string; testId?: string; label?: string; caption?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="cx-code">
      <div className="cx-code-bar">
        <span className="cx-code-caption">{caption}</span>
        <button
        type="button"
        className="cx-copy"
        aria-label={done ? "Copied" : label}
        title={done ? "Copied" : label}
        onClick={async () => {
          if (await copyText(text)) {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          }
        }}
      >
        {done ? <Check size={14} strokeWidth={STROKE} aria-hidden /> : <Copy size={14} strokeWidth={STROKE} aria-hidden />}
        <span>{done ? "Copied" : label}</span>
      </button>
      </div>
      <pre data-testid={testId}>{text}</pre>
    </div>
  );
}

/**
 * Body of the "Install MCP" dropdown: the detected server, one tab per agent with its exact install
 * command or config snippet (Copy), and who is connected right now.
 */
export function InstallMcpMenu({ onClose }: { onClose(): void }) {
  void onClose;
  const [state, refresh] = useConnectInfo();
  const agents = useAgentList();
  const agent = useAgentState();
  const snippets = state.status === "ok" ? state.info.install : offlineSnippets(state.status === "offline" ? state.base : "http://localhost:7780");
  const [tab, setTab] = useState<string>("claude-code");
  const current = snippets.find((s) => s.id === tab) ?? snippets[0]!;
  const online = state.status === "ok";
  return (
    <div className="menu-body cx-menu" data-testid="install-mcp-menu">
      <div className="cx-head">
        <div className="menu-title">Connect an agent</div>
        <button type="button" className="cx-icon" aria-label="Check again" title="Check again" onClick={refresh}>
          <RefreshCw size={13} strokeWidth={STROKE} aria-hidden />
        </button>
      </div>
      <div className={`cx-server ${online ? "is-on" : state.status === "offline" ? "is-off" : ""}`} data-testid="mcp-server-status">
        <span className="cx-dot" aria-hidden />
        {state.status === "loading" ? (
          <span>Looking for the Fabwright server…</span>
        ) : online ? (
          <span>
            MCP server running at <code>{state.info.mcpUrl}</code>
          </span>
        ) : (
          <span>
            No Fabwright server at <code>{state.base}</code>. Start it with <code>pnpm start</code>, then add it to your agent.
          </span>
        )}
      </div>
      <div className="cx-tabs" role="tablist" aria-label="Agent">
        {snippets.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={s.id === current.id} className={`cx-tab ${s.id === current.id ? "is-active" : ""}`} onClick={() => setTab(s.id)} data-testid={`mcp-tab-${s.id}`}>
            {s.label}
          </button>
        ))}
      </div>
      <CopyBlock text={current.text} testId={`mcp-snippet-${current.id}`} caption={current.kind === "command" ? `Run in ${current.where}` : `Add to ${current.where}`} />
      {current.note ? <p className="menu-text cx-note">{current.note}</p> : null}
      <div className="cx-section-title">Agent</div>
      <div className="cx-state" data-testid="mcp-agent-state" data-agent-status={agent.status}>
        <span className={`cx-dot ${agent.status === "building" ? "is-busy" : agent.status === "idle" ? "is-on" : "is-off"}`} aria-hidden />
        <span>{agent.status === "none" ? "No agent yet: nothing has called a Fabwright tool." : agentLabel(agent)}</span>
      </div>
      {agents.length ? (
        <ul className="cx-agents" data-testid="mcp-agents">
          {agents.map((a) => (
            <li key={a.id}>
              <span className={`cx-dot ${a.busy ? "is-busy" : a.calls ? "is-on" : ""}`} aria-hidden />
              <span className="cx-agent-name">{a.name}</span>
              <span className="cx-agent-meta">{a.busy ? `building · ${[a.busy.op.replace(/_/g, " "), a.busy.target].filter(Boolean).join(" ")}` : a.calls ? `${a.calls} ${a.calls === 1 ? "call" : "calls"}${a.transport === "stdio-attach" ? " · stdio" : ""}` : "connected, no tool called yet"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="menu-text cx-muted">{agent.status === "none" ? "Add Fabwright to your agent with the command above, then ask it to build something. Every part it places shows up here live." : "Its MCP session has ended."}</p>
      )}
    </div>
  );
}
