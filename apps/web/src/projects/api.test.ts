import { afterEach, describe, expect, it } from "vitest";
import { actorLabel, ago, entityLabel, resetServerConnection, serverConnection } from "./api.ts";

describe("projects api helpers", () => {
  afterEach(() => resetServerConnection());

  it("finds the server only when /api/connect answers JSON with a token", async () => {
    const html = (async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    expect(await serverConnection(html)).toBeNull();
    resetServerConnection();
    const ok = (async () => Response.json({ token: "t0k" })) as typeof fetch;
    expect(await serverConnection(ok)).toEqual({ token: "t0k" });
    resetServerConnection();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await serverConnection(down)).toBeNull();
  });

  it("says who and when in plain words", () => {
    expect(actorLabel("mcp", "claude-code 2.1.319")).toBe("Claude Code");
    expect(actorLabel("mcp", "codex-cli 0.163.0")).toBe("Codex");
    expect(actorLabel("web")).toBe("You");
    expect(actorLabel("cli")).toBe("CLI");
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(ago("2026-11-10T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-11-10T11:57:00Z", now)).toBe("3 min ago");
    expect(ago("2026-11-09T12:00:00Z", now)).toBe("yesterday");
    expect(entityLabel("part:led1")).toEqual({ kind: "part", id: "led1" });
    expect(entityLabel("file:firmware/main.ino")).toEqual({ kind: "file", id: "firmware/main.ino" });
    expect(entityLabel("firmware")).toEqual({ kind: "firmware", id: "firmware block" });
  });
});
