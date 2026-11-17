// Round 10 (network): the generic device network through the agent surface (no Docker, no
// firmware): set_network writes fabwright.json (names only, literal keys refused with the fix),
// add_mock_api writes network/mocks.json and applies live, try_request goes through the sandbox
// exactly like a device (DNS, TLS with the sandbox CA, mocks, faults), read_network shows it all
// with secrets as names, scenario request / network_fault steps run against the log, and the
// factory pack gets firmware/NETWORK.md.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseScenarioStep } from "@fabwright/project-format";
import type { BuildRequest, BuildResult } from "@fabwright/runner";
import { ProjectSession } from "../src/index.ts";

const SECRET = "wk-test-0123456789abcdefSECRETVALUE";
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}`);
};
let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fabwright-net-tools-"));
  process.env.FABWRIGHT_SANDBOX_CA_DIR = join(dir, "ca");
  s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
  await call("new_project", { template: "blank", name: "net" });
});
afterAll(async () => {
  s.dispose();
  await s.deviceNetwork.close();
  delete process.env.FABWRIGHT_SANDBOX_CA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("network tools", () => {
  it("set_network stores names only and refuses a literal key with the fix", async () => {
    await expect(call("set_network", { mode: "internet", allow: [{ host: "api.weather.test", headers: { Authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz123" } }] })).rejects.toThrow(/literal API key.*Fix: use a template/);
    const r = await call("set_network", { secrets: ["WEATHER_KEY"], wifi: { ssid: "Home" } });
    expect(r.secrets).toEqual([{ name: "WEATHER_KEY", set: false, hosts: [] }]);
    expect(r.note).toContain(".env");
    writeFileSync(join(dir, ".env"), `WEATHER_KEY=${SECRET}\n`);
    const r2 = await call("set_network", { allow: [{ host: "api.weather.test", secrets: ["WEATHER_KEY"], headers: { "X-Api-Key": "{{secret:WEATHER_KEY}}" } }] });
    expect(r2.secrets).toEqual([{ name: "WEATHER_KEY", set: true, hosts: ["api.weather.test"] }]);
    expect(r2.factory_notes).toContain("api.weather.test");
    const json = readFileSync(join(dir, "fabwright.json"), "utf8");
    expect(json).toContain('"network"');
    expect(json).toContain("{{secret:WEATHER_KEY}}");
    expect(json).not.toContain(SECRET);
    await expect(call("set_network", { mode: "sometimes" })).rejects.toThrow(/mode/);
  });

  it("add_mock_api + try_request: a mocked HTTPS API answers through the sandbox, faults apply, the log shows it", async () => {
    const m = await call("add_mock_api", { mock: { host: "api.weather.test", path: "/v1/now", response: { body: { temp_c: 21.5 } } } });
    expect(m.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "network/mocks.json"), "utf8")).mocks).toHaveLength(1);
    await expect(call("add_mock_api", { mock: { host: "api.weather.test", path: "nope", response: {} } })).rejects.toThrow(/path must start with \/.*Fix/);
    const r = await call("try_request", { url: "https://api.weather.test/v1/now" });
    expect(r).toMatchObject({ ok: true, status: 200, body: '{"temp_c":21.5}' });
    await call("inject_network_fault", { fault: { kind: "http_error", status: 503, count: 1 } });
    expect((await call("try_request", { url: "https://api.weather.test/v1/now" })).status).toBe(503);
    expect((await call("try_request", { url: "https://api.weather.test/v1/now" })).status).toBe(200);
    const blocked = await call("try_request", { url: "https://nowhere.example.test/" });
    expect(blocked.ok).toBe(false);
    expect(blocked.why).toContain("never reaches the internet");
    expect(blocked.fix).toBeTruthy();
    await expect(call("inject_network_fault", { fault: { kind: "earthquake" } })).rejects.toThrow(/not a network fault.*Fix/);
    const log = await call("read_network", {});
    expect(log.mode).toBe("mock");
    expect(log.secrets).toEqual([{ name: "WEATHER_KEY", set: true, hosts: ["api.weather.test"] }]);
    expect(log.entries.some((e: { kind: string; status?: number }) => e.kind === "http" && e.status === 503)).toBe(true);
    expect(log.entries.some((e: { kind: string; host?: string }) => e.kind === "blocked" && e.host === "nowhere.example.test")).toBe(true);
    expect(JSON.stringify(log)).not.toContain(SECRET);
    expect(log.boards_note).toBeTruthy();
  }, 30_000);

  it("validates the scenario steps", () => {
    expect(parseScenarioStep({ request: { host: "api.weather.test", path: "/v1/now", status: 200 }, within_ms: 5000 }, "s").ok).toBe(true);
    expect(parseScenarioStep({ network_fault: { kind: "wifi_drop" } }, "s").ok).toBe(true);
    expect(parseScenarioStep({ network_fault: { kind: "volcano" } }, "s").ok).toBe(false);
  });

  it("export_manufacturing writes firmware/NETWORK.md with names, never values", async () => {
    const r = await call("export_manufacturing", {});
    const f = join(r.dir, "firmware", "NETWORK.md");
    expect(existsSync(f)).toBe(true);
    const text = readFileSync(f, "utf8");
    expect(text).toContain("api.weather.test");
    expect(text).toContain("WEATHER_KEY");
    expect(text).toContain("relay");
    expect(text).not.toContain(SECRET);
  }, 60_000);
});
