import { describe, expect, it } from "vitest";
import { agentDisplayName, createAgentStateTracker } from "../src/agent-state.ts";
import type { AgentState } from "../src/live-events.ts";
import type { AgentPresence } from "../src/live.ts";
import type { ActionEntry } from "../src/session.ts";

// The one agent state (decision 0003, C6): none until a tool is called, building while calls
// arrive, idle after 10 s of quiet with a session open, done when every calling session ended.
function setup() {
  let t = 1_000_000;
  const seen: AgentState[] = [];
  const tr = createAgentStateTracker({ ownSid: "own", now: () => t, onChange: (s) => seen.push(s) });
  return { tr, seen, advance: (ms: number) => (t += ms) };
}
const entry = (p: Partial<ActionEntry>): ActionEntry => ({ seq: 1, t: new Date().toISOString(), actor: "mcp", sid: "own", op: "place_part", args: {}, ok: true, ...p });
const agent = (p: Partial<AgentPresence>): AgentPresence => ({ id: "s1", name: "Claude Code", client: "claude-code", transport: "http", connectedAt: "", lastSeen: "", calls: 0, ...p });

describe("agent state", () => {
  it("stays none when a client only connects, and for the person's own actions", () => {
    const { tr } = setup();
    tr.presence([agent({ calls: 0 })]);
    tr.action(entry({ actor: "web" }));
    tr.action(entry({ actor: "cli" }));
    expect(tr.state()).toMatchObject({ status: "none", actions: 0 });
  });

  it("building while calls arrive, idle after 10 s with the session open, done when it ends", () => {
    const { tr, advance } = setup();
    tr.presence([agent({ calls: 1, busy: { op: "place_part", target: "led1", since: "" } })]);
    expect(tr.state()).toMatchObject({ status: "building", agent: "Claude Code", current: { op: "place_part", target: "led1" } });
    tr.presence([agent({ calls: 1, last: { op: "place_part", ok: true, at: new Date(1_000_000).toISOString() } })]);
    tr.action(entry({}));
    tr.action(entry({ ok: false, error: "nope" }));
    expect(tr.state()).toMatchObject({ status: "building", actions: 2, failed: 1 });
    advance(9_000);
    expect(tr.state().status).toBe("building");
    advance(1_500);
    expect(tr.state().status).toBe("idle");
    tr.presence([]);
    expect(tr.state()).toMatchObject({ status: "done", actions: 2 });
  });

  it("a stdio MCP process (another sid) counts, and stays idle (its end is not visible)", () => {
    const { tr, advance } = setup();
    tr.action(entry({ sid: "other", client: "codex-mcp-client 0.163.0" }));
    expect(tr.state()).toMatchObject({ status: "building", agent: "Codex", actions: 1 });
    advance(11_000);
    expect(tr.state().status).toBe("idle");
  });

  it("reports changes once each", () => {
    const { tr, seen } = setup();
    tr.presence([]);
    tr.presence([]);
    tr.action(entry({}));
    expect(seen.map((s) => s.status)).toEqual(["none", "building"]);
    tr.dispose();
  });

  it("names clients like the MCP endpoint", () => {
    expect(agentDisplayName("claude-code 2.1.319")).toBe("Claude Code");
    expect(agentDisplayName("my_agent 1")).toBe("My Agent");
    expect(agentDisplayName(undefined)).toBeUndefined();
  });
});
