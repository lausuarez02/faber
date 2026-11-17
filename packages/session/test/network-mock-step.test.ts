// Round 10 live weather eval: (1) a mock path with a query was accepted but never answered;
// (2) the agent could not test the dry forecast next to the rainy one ("the fake service can only
// give one answer at a time"). A scenario's network_mock step now answers for that test only.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseScenarioStep } from "@faber/project-format";
import type { BuildRequest, BuildResult } from "@faber/runner";
import { ProjectSession } from "../src/index.ts";

const GOLDEN = readFileSync(fileURLToPath(new URL("../../../examples/blink/firmware/blink.hex", import.meta.url)), "utf8");
const fakeBuilder = async (_req: BuildRequest): Promise<BuildResult> => ({ ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, size: { flash: 1992, flashMax: 32256, ram: 202, ramMax: 2048 }, libraries: [], logTail: "" });
let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;
const RAIN = { host: "api.open-meteo.com", path: "/v1/forecast", response: { body: { rain: 90 } } };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "faber-net-mockstep-"));
  process.env.FABER_SANDBOX_CA_DIR = join(dir, "ca");
  s = new ProjectSession({ dir, builder: fakeBuilder, actor: "test" });
  await call("new_project", { template: "blink", name: "weather" });
  await call("set_network", { wifi: { ssid: "Home" } });
  await call("add_mock_api", { mock: RAIN });
});
afterAll(async () => {
  s.dispose();
  await s.deviceNetwork.close();
  delete process.env.FABER_SANDBOX_CA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("mocks per request and per test", () => {
  it("a mock path with a query answers only requests with those parameters", async () => {
    await call("add_mock_api", { mock: { host: "api.open-meteo.com", path: "/v1/forecast?latitude=40.42*", response: { body: { place: "madrid" } } } });
    // file order: the plain /v1/forecast mock was first, so it still answers everything else
    expect((await call("try_request", { url: "https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13" })).body).toBe('{"rain":90}');
    const net = await s.deviceNetwork.ensure();
    net.setMocks([net.mocks.list[1]!, net.mocks.list[0]!]);
    expect((await call("try_request", { url: "https://api.open-meteo.com/v1/forecast?latitude=40.42&longitude=-3.70&hourly=x" })).body).toBe('{"place":"madrid"}');
    expect((await call("try_request", { url: "https://api.open-meteo.com/v1/forecast?latitude=51.51" })).body).toBe('{"rain":90}');
    net.setMocks([net.mocks.list[1]!]);
  }, 30_000);

  it("network_mock is a valid step, and a bad mock in it is refused with the fix", async () => {
    expect(parseScenarioStep({ network_mock: { host: "api.open-meteo.com", path: "/v1/forecast", response: { body: { rain: 0 } } } }, "s").ok).toBe(true);
    await expect(call("write_scenario", { id: "bad", steps: [{ network_mock: { host: "api.open-meteo.com", path: "nope", response: {} } }] })).rejects.toThrow(/network_mock.*path must start with \/.*Fix/);
  });

  it("a scenario's network_mock answers ahead of mocks.json during that test, and the project's mocks come back after it", async () => {
    await call("write_scenario", {
      id: "dry",
      steps: [{ network_mock: { host: "api.open-meteo.com", path: "/v1/forecast", response: { body: { rain: 0 } } } }, { run_ms: 50 }],
    });
    const net = await s.deviceNetwork.ensure();
    const before = JSON.stringify(net.mocks.list);
    // the mock is live while the scenario runs: look from inside it
    const seen: string[] = [];
    const orig = net.scenarioMock.bind(net);
    net.scenarioMock = (m) => {
      orig(m);
      seen.push(JSON.stringify(net.mocks.list[0]));
    };
    const r = await call("run_tests", { name: "dry" });
    net.scenarioMock = orig;
    expect(r.passed).toBe(1);
    expect(seen[0]).toContain('"rain":0');
    expect(JSON.stringify(net.mocks.list)).toBe(before);
    expect((await call("try_request", { url: "https://api.open-meteo.com/v1/forecast?latitude=1" })).body).toBe('{"rain":90}');
    // nothing written to mocks.json
    expect(readFileSync(join(dir, "network/mocks.json"), "utf8")).not.toContain('"rain": 0');
  }, 60_000);
});
