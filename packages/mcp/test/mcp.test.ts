import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canBuildArduino, TOOLS } from "@fabwright/session";

const BIN = fileURLToPath(new URL("../bin/fabwright-mcp.mjs", import.meta.url));
// Round 11: Docker or the native AVR toolchain can build Blink.
const dockerUp = canBuildArduino("arduino:avr:uno").ok || (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

type ToolResult = { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
const json = (r: ToolResult) => JSON.parse(r.content[0]!.text!) as Record<string, unknown>;

describe("fabwright MCP server over stdio", () => {
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "fabwright-mcp-"));
    client = new Client({ name: "fabwright-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "--project", dir], stderr: "ignore" }));
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every session op as a tool, with instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(client.getInstructions()).toMatch(/search_parts/);
  });

  it("serves the agent guide, catalog and project as resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(["fabwright://docs/hardware", "fabwright://docs/agents", "fabwright://parts", "fabwright://project"]);
    const hw = await client.readResource({ uri: "fabwright://docs/hardware" });
    const text = String((hw.contents[0] as { text?: string }).text);
    expect(text).toMatch(/Always think how it goes inside/);
    expect(text).toMatch(/Insertion order/);
    expect(text).toMatch(/Buy.*\n.*Print.*\n.*Assemble.*\n.*Flash/);
    const parts = await client.readResource({ uri: "fabwright://parts" });
    expect(String((parts.contents[0] as { text?: string }).text)).toMatch(/arduino-uno \[board/);
  });

  it("round 12 skill: serves the hardware know-how as prompts, and the instructions carry the design-for-assembly rules", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["design-device", "build-kit", "design-for-assembly"]);
    expect(prompts[0]!.arguments).toEqual([expect.objectContaining({ name: "goal", required: true })]);
    const dd = await client.getPrompt({ name: "design-device", arguments: { goal: "a keychain with a little screen that shows a smiley" } });
    const t = (dd.messages[0]!.content as { text: string }).text;
    expect(t).toMatch(/^I want to build: a keychain with a little screen/);
    expect(t.indexOf("check_fit")).toBeLessThan(t.indexOf("`design_case`"));
    expect(t).toMatch(/20 mm thick or less/);
    const kit = await client.getPrompt({ name: "build-kit" });
    expect((kit.messages[0]!.content as { text: string }).text).toMatch(/what to buy, what to print/);
    const dfa = await client.getPrompt({ name: "design-for-assembly" });
    expect((dfa.messages[0]!.content as { text: string }).text).toMatch(/Battery safety/);
    await expect(client.getPrompt({ name: "design-device", arguments: {} })).rejects.toThrow(/needs a goal.*Fix:/);
    await expect(client.getPrompt({ name: "nope" })).rejects.toThrow(/No prompt 'nope'.*Fix:/);
    const ins = client.getInstructions() ?? "";
    expect(ins).toMatch(/Design for assembly/);
    expect(ins).toMatch(/resource fabwright:\/\/docs\/hardware; prompts design-device, build-kit, design-for-assembly/);
  });

  it("returns errors that say what, why and how to fix", async () => {
    const r = (await client.callTool({ name: "place_part", arguments: { type: "ledd" } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/No part type 'ledd'.*Fix:.*Did you mean 'led'/);
  });

  it("write_scenario: the regex forms agents guess first work, and a wrong key says how to fix it", async () => {
    await client.callTool({ name: "new_project", arguments: { template: "uno", overwrite: true } });
    const ok = (await client.callTool({ name: "write_scenario", arguments: { id: "mood", steps: [{ expect_serial: "MOOD", regex: "MOOD \\w+ -> sad", within_ms: 50000 }] } })) as ToolResult;
    expect(ok.isError).toBeFalsy();
    expect(String(json(ok).normalized)).toMatch(/inside expect_serial/);
    const bad = (await client.callTool({ name: "write_scenario", arguments: { id: "mood2", steps: [{ expect_serial: "MOOD", pattern: "MOOD" }] } })) as ToolResult;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/unknown field\(s\) 'pattern'.*Fix: put the pattern inside expect_serial/);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "write_scenario")!.description).toMatch(/\{"expect_serial": \{"regex": "hunger=/);
    await client.callTool({ name: "new_project", arguments: { template: "blank", overwrite: true } });
  });

  it.skipIf(!dockerUp)(
    "places, wires, builds and runs Blink end to end",
    async () => {
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        // build may compile in Docker for minutes on a cold machine; the MCP client default is 60 s
        const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })) as ToolResult;
        if (r.isError) throw new Error(`${name}: ${r.content[0]!.text}`);
        return r;
      };
      await call("new_project", { template: "blank", name: "mcp-blink" });
      expect(json(await call("place_part", { type: "arduino-uno" })).id).toBe("uno");
      await call("place_part", { type: "resistor", props: { resistance: 220 } });
      await call("place_part", { type: "led" });
      await call("connect", { from: "uno.D13", to: "r1.1", why: "drive the LED from D13" });
      await call("connect", { from: "r1.2", to: "led1.A" });
      await call("connect", { from: "led1.C", to: "uno.GND" });
      expect(json(await call("check_design")).errors).toBe(0);
      await call("write_file", {
        path: "firmware/main.ino",
        content: 'void setup(){Serial.begin(115200);pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);Serial.println("LED on");delay(1000);digitalWrite(13,LOW);Serial.println("LED off");delay(1000);}\n',
      });
      const build = json(await call("build"));
      expect(build.ok).toBe(true);
      const run = json(await call("run", { ms: 1500 }));
      expect(run.serial).toMatch(/LED on\r\nLED off/);
      await call("write_scenario", { id: "blinks", steps: [{ expect_serial: "LED on", within_ms: 1100 }, { expect_pin: "uno.D13", level: "high" }] });
      const tests = json(await call("run_tests"));
      expect(tests).toMatchObject({ passed: 1, failed: 0 });
      const shot = (await call("screenshot", { path: "shot.png" })) as ToolResult;
      expect(shot.content.some((c) => c.type === "image" || /"format":"svg"/.test(c.text ?? ""))).toBe(true);
    },
    660_000,
  );
});
