// examples/ai-pet through the agent surface (the session, as MCP clients use it), with the
// committed golden firmware and the deterministic mock AI: every scenario passes, twice in a row
// with identical replies, and the network log shows what the device did.
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSession } from "../../../packages/session/src/index.ts";

const EXAMPLE = fileURLToPath(new URL("../../../examples/ai-pet/", import.meta.url));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

function open(): ProjectSession {
  const dir = mkdtempSync(join(tmpdir(), "jumper-ai-pet-"));
  cpSync(EXAMPLE, dir, { recursive: true, preserveTimestamps: true });
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(dir, "firmware/ai-pet.hex"), later, later);
  const s = new ProjectSession({
    dir,
    builder: async () => {
      throw new Error("unexpected build: the golden hex should be fresh");
    },
    actor: "test",
  });
  cleanup.push(() => {
    s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

describe("examples/ai-pet", () => {
  it("every scenario passes with the mock AI", async () => {
    const s = open();
    const t = await call(s, "run_tests");
    expect(t.failed, JSON.stringify(t.results?.filter((r: { passed: boolean }) => !r.passed), null, 1)).toBe(0);
    expect(t.passed).toBe(5);
  }, 300_000);

  it("is deterministic: the same press gives the same reply at the same virtual time", async () => {
    const replies: string[] = [];
    for (let i = 0; i < 2; i++) {
      const s = open();
      await call(s, "run", { ms: 7000 });
      await call(s, "interact", { part: "btnTalk", action: "click", hold_ms: 80 });
      await call(s, "run", { ms: 2500 });
      const serial = (await call(s, "read_serial")) as Record<string, any>;
      const text = JSON.stringify(serial);
      const m = /reply 200 [a-z]+\|[^\\]+/.exec(text);
      expect(m, text).not.toBeNull();
      replies.push(m![0]);
    }
    expect(replies[0]).toBe(replies[1]);
  }, 120_000);

  it("golden firmware matches the build recipe", () => {
    const hex = readFileSync(join(EXAMPLE, "firmware/ai-pet.hex"), "utf8");
    expect(hex.startsWith(":")).toBe(true);
    expect(readFileSync(join(EXAMPLE, "jumper.json"), "utf8")).toContain('"artifact": "firmware/ai-pet.hex"');
  });
});

describe.runIf(process.env.JUMPER_LIVE_AI === "1")("examples/ai-pet with the live AI (JUMPER_LIVE_AI=1)", () => {
  it("TALK gets a real model's reply on the simulated screen", async () => {
    const { SimHost } = await import("../../../packages/session/src/sim.ts");
    const { setAiMode, runLive, readNetworkLog } = await import("../../../packages/session/src/network.ts");
    const { parseProject } = await import("../../../packages/project-format/src/index.ts");
    const { registry } = await import("../../../packages/parts/src/index.ts");
    const { colorFrameToPng } = await import("../../../packages/sim-core/src/index.ts");
    const { writeFileSync } = await import("node:fs");
    const project = parseProject(readFileSync(join(EXAMPLE, "jumper.json"), "utf8"));
    const host = new SimHost(project, registry, readFileSync(join(EXAMPLE, "firmware/ai-pet.hex"), "utf8"));
    cleanup.push(() => host.dispose());
    process.env.JUMPER_AI_PROVIDER ??= process.env.ANTHROPIC_API_KEY ? "anthropic-api" : "claude-cli"; // tests default to mock only
    console.log(setAiMode(host.network, "live"));
    host.run(7000);
    host.sim.interact("btnTalk", { kind: "press" });
    host.run(80);
    host.sim.interact("btnTalk", { kind: "release" });
    const r = await runLive(host.network, (ms) => host.run(ms), 9000);
    console.log(JSON.stringify(r, null, 1));
    console.log(host.sim.serialText().split("\r\n").filter((l) => /ask|reply|bubble/.test(l)).join("\n"));
    if (process.env.JUMPER_LIVE_PNG) writeFileSync(process.env.JUMPER_LIVE_PNG, colorFrameToPng(host.sim.framebuffer("tft")!, 2));
    const log = readNetworkLog(host.network);
    expect(JSON.stringify(log)).toMatch(/Claude CLI|Anthropic API/);
    expect(host.sim.serialText()).toMatch(/reply 200 [a-z]+\|/);
  }, 60_000);
});
