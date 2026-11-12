// Round 13: the build kit's Connect section and the relay in the kit and the factory pack.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { ProjectSession } from "../src/index.ts";

const KEY = "sk-kit-connect-test-value-0123456789";
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}`);
};
const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterAll(() => {
  for (const s of sessions) s.dispose();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

async function project(network?: Record<string, unknown>, template = "xiao-esp32s3"): Promise<ProjectSession> {
  const dir = mkdtempSync(join(tmpdir(), "jumper-kit-connect-"));
  dirs.push(dir);
  const s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
  sessions.push(s);
  await call(s, "new_project", { template });
  if (network) await call(s, "set_network", network);
  return s;
}

describe("build kit: Connect", () => {
  it("a device that calls an API with a key gets keys / relay / tokens / Wi-Fi / check / cost, never a key value", async () => {
    const s = await project({ secrets: ["API_KEY"], allow: [{ host: "api.example.com", secrets: ["API_KEY"], headers: { Authorization: "Bearer {{secret:API_KEY}}" } }, { host: "direct.example.com", tls: "passthrough" }], relay: { requests_per_minute: 10 } });
    writeFileSync(join(s.dir, ".env"), `API_KEY=${KEY}\n`);
    const r = await call(s, "get_build_kit", { pdf: false, slicer: "off" });
    const c = r.kit.connect;
    expect(c, JSON.stringify(Object.keys(r.kit))).toBeTruthy();
    expect(c.needs_relay).toBe(true);
    expect(c.steps.map((x: { title: string }) => x.title)).toEqual(["Your API keys", "Set up the relay", "A token for each device", "Wi-Fi and the relay address on the device", "Check it"]);
    expect(c.secrets).toEqual([{ name: "API_KEY", hosts: ["api.example.com"], set: true }]);
    const cmds = c.steps.flatMap((x: { commands?: { cmd: string }[] }) => (x.commands ?? []).map((k) => k.cmd)).join("\n");
    expect(cmds).toContain("npx wrangler secret put RELAY_DEVICE_TOKENS");
    expect(cmds).toContain("npx wrangler secret put API_KEY");
    expect(cmds).toContain("jumper relay serve");
    expect(cmds).toContain("jumper relay token add");
    expect(cmds).toContain("jumper relay device-header");
    expect(cmds).toMatch(/arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32S3 --upload/);
    expect(c.cost.join(" ")).toContain("14,400 a day at worst"); // 10 a minute
    expect(c.notes.join(" ")).toContain("direct.example.com");
    // the files: the section in KIT.md and kit.html, the relay folder in the download, no key anywhere
    const md = readFileSync(r.files.markdown, "utf8");
    const html = readFileSync(r.files.html, "utf8");
    expect(md).toContain("## Connect");
    expect(html).toContain('id="connect"');
    expect(html).toContain('href="#connect"');
    for (const f of ["relay/server.mjs", "relay/worker.js", "relay/wrangler.toml", "relay/README.md", "relay/firmware/JumperRelay.h"]) expect(existsSync(join(r.files.dir, f)), f).toBe(true);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(md).not.toContain(KEY);
    expect(html).not.toContain(KEY);
  });

  it("a key that is not set yet says so; a project without keys needs no relay; one without a network has no Connect", async () => {
    const s = await project({ secrets: ["API_KEY"], allow: [{ host: "api.example.com", secrets: ["API_KEY"] }] });
    const r = await call(s, "get_build_kit", { write: false, slicer: "off" });
    expect(r.kit.connect.secrets[0].set).toBe(false);
    expect(r.kit.connect.steps[0].do[0]).toContain("not set on this computer yet");
    const open = await project({ allow: [{ host: "api.open-meteo.com" }] });
    const r2 = await call(open, "get_build_kit", { write: false, slicer: "off" });
    expect(r2.kit.connect.needs_relay).toBe(false);
    expect(r2.kit.connect.steps.map((x: { title: string }) => x.title)).toEqual(["Wi-Fi and the relay address on the device", "Check it"]);
    expect(r.kit.connect.warning).toBeUndefined();
    // a board without Wi-Fi: said first, with what to use instead
    const uno = await project({ secrets: ["API_KEY"], allow: [{ host: "api.example.com", secrets: ["API_KEY"] }] }, "uno");
    const r3 = await call(uno, "get_build_kit", { write: false, slicer: "off" });
    expect(r3.kit.connect.warning).toMatch(/has no Wi-Fi.*ESP32/);
    const none = await project();
    expect((await call(none, "get_build_kit", { write: false, slicer: "off" })).kit.connect).toBeUndefined();
  });

  it("the factory pack carries relay/ and NETWORK.md points at it", async () => {
    const s = await project({ secrets: ["API_KEY"], allow: [{ host: "api.example.com", secrets: ["API_KEY"] }] });
    writeFileSync(join(s.dir, ".env"), `API_KEY=${KEY}\n`);
    const r = await call(s, "export_manufacturing", { zip: false });
    const root = r.dir ?? r.folder ?? r.path;
    expect(typeof root, JSON.stringify(r).slice(0, 400)).toBe("string");
    expect(existsSync(join(root, "relay", "worker.js"))).toBe(true);
    expect(readFileSync(join(root, "firmware", "NETWORK.md"), "utf8")).toContain("relay/");
    expect(readFileSync(join(root, "relay", "relay.config.mjs"), "utf8")).not.toContain(KEY);
  });
});
