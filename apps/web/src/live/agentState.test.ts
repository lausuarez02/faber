import { describe, expect, it } from "vitest";
import { agentLabel, NO_AGENT } from "./agentState.ts";
import { followBase } from "./followRun.ts";

// One agent state, one wording (decision 0003, C6).
describe("agent label", () => {
  it("says No agent until a tool is called, then building / idle / done with real counts", () => {
    expect(agentLabel(NO_AGENT)).toBe("No agent");
    expect(agentLabel({ status: "building", agent: "Claude Code", actions: 3, failed: 0, current: { op: "place_part", target: "led1" } })).toBe("Claude Code building · place part led1");
    expect(agentLabel({ status: "building", actions: 1, failed: 0 })).toBe("Agent building · 1 action");
    expect(agentLabel({ status: "idle", agent: "Codex", actions: 12, failed: 1 })).toBe("Codex idle · 12 actions");
    expect(agentLabel({ status: "done", agent: "Codex", actions: 12, failed: 1 })).toBe("Codex done · 12 actions");
  });

  it("finds the followed server from ?follow", () => {
    expect(followBase("?follow=" + encodeURIComponent("ws://localhost:7791/live"))).toBe("http://localhost:7791");
    expect(followBase("?follow=wss://x.test/live")).toBe("https://x.test");
    expect(followBase("?local")).toBeUndefined();
  });
});
