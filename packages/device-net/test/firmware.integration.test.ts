// Real ESP32-S3 firmware through Jumper's device network: the net-probe sketch (fixtures/net-probe,
// a plain WiFi.h + HTTPClient + PubSubClient sketch with a real root CA, built with the
// jumper/arduino-esp32 r3 simulation image) boots in Espressif's QEMU in lockstep, its OpenCores
// network card plugged into the netstack of a DeviceNetHost. Checked: the Wi-Fi shim joins, DHCP,
// DNS, HTTPS to a mock (mbedTLS trusts the sandbox CA), a blocked host with why / fix, a secret
// added at the edge and masked everywhere, MQTT publish + reply, and Wi-Fi drop + reconnect.
// Needs the QEMU image (Docker) or Jumper's native QEMU (jumper setup esp32) and the fixture; skipped otherwise.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardMac, QemuEspBackend, qemuImageAvailable } from "@jumper/sim-backends/qemu-esp";
import { SandboxCA } from "../src/ca.ts";
import { parseMocks, parseNetworkConfig } from "../src/config.ts";
import { DeviceNetHost } from "../src/host.ts";
import { checkRequest, readNetwork } from "../src/tools.ts";

const SECRET = "wk-live-0123456789abcdefSECRET";
/** "The internet": an HTTPS API with its own CA that echoes the key it got (a bad API; the device must still never see it). */
const UPSTREAM_JS = `
const https = require("node:https");
const { parentPort, workerData } = require("node:worker_threads");
const server = https.createServer({ key: workerData.key, cert: workerData.cert }, (req, res) => {
  workerData.port.postMessage(String(req.headers["x-api-key"] ?? ""));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, echoed: req.headers["x-api-key"] ?? null }));
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
`;
const FIXTURE = fileURLToPath(new URL("../fixtures/net-probe.esp32s3.merged.bin.gz", import.meta.url));
const available = existsSync(FIXTURE) && qemuImageAvailable();
const flash = () => new Uint8Array(gunzipSync(readFileSync(FIXTURE)));

describe.skipIf(!available)("real ESP32-S3 firmware through the device network (QEMU, lockstep)", () => {
  let dir: string;
  let upstream: Worker;
  let upstreamPort = 0;
  let auth: MessagePort;
  let host: DeviceNetHost;
  let be: QemuEspBackend;
  let serial = "";
  const upstreamAuth: string[] = [];
  /** The x-api-key values the upstream thread saw so far (read without an event-loop turn). */
  const drainAuth = () => {
    for (let m = receiveMessageOnPort(auth); m; m = receiveMessageOnPort(auth)) upstreamAuth.push(String(m.message));
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "jumper-fw-net-"));
    const publicCa = await SandboxCA.open(join(dir, "public-ca"));
    // The upstream runs in its own thread: this one is busy stepping the emulator in lockstep, so a
    // server here would never answer (round 11: found when the fixture was first built).
    const { port1, port2 } = new MessageChannel();
    auth = port1;
    upstream = new Worker(UPSTREAM_JS, { eval: true, workerData: { ...(await publicCa.leafPem("secure.api.test")), port: port2 }, transferList: [port2] });
    upstreamPort = await new Promise<number>((resolve, reject) => {
      upstream.once("message", resolve);
      upstream.once("error", reject);
    });
    host = await DeviceNetHost.start({
      config: parseNetworkConfig({
        mode: "internet",
        wifi: { ssid: "JumperNet", password: "hunter22-wifi" },
        secrets: ["WEATHER_KEY"],
        allow: [{ host: "secure.api.test", secrets: ["WEATHER_KEY"], headers: { "X-Api-Key": "{{secret:WEATHER_KEY}}" } }],
      }),
      mocks: parseMocks({
        mocks: [
          { host: "api.weather.test", path: "/v1/now", response: { body: { temp_c: 21.5, sky: "clear" } } },
          { kind: "mqtt", host: "mqtt.example.test", on_publish: [{ topic: "devices/+/telemetry", reply: [{ topic: "devices/probe/cmd", payload: '{"led":"on"}' }] }] },
        ],
      }),
      secrets: new Map([["WEATHER_KEY", SECRET]]),
      caDir: join(dir, "ca"),
      upstreams: { "secure.api.test": { host: "127.0.0.1", port: upstreamPort, ca: publicCa.certPem } },
    });
    be = new QemuEspBackend({ chip: "esp32s3", network: { framePort: host.framePort, mac: boardMac(1) } });
    be.onSerial((b) => (serial += String.fromCharCode(b)));
    be.load(flash());
  }, 60_000);

  afterAll(async () => {
    be?.close();
    await host?.close();
    await upstream?.terminate();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Lockstep in 5 ms steps until `done` or `maxMs` of virtual time; the network runs in its own thread meanwhile. */
  function runUntil(done: () => boolean, maxMs: number): number {
    const step = Math.round((be.cyclesPerSecond * 5) / 1000);
    const end = be.cycles + Math.round((be.cyclesPerSecond * maxMs) / 1000);
    while (be.cycles < end && !done()) be.step(step);
    return (be.cycles * 1000) / be.cyclesPerSecond;
  }

  it("joins the sandbox Wi-Fi, gets a lease, fetches a mocked API over HTTPS, is refused a blocked host, gets a secret added at the edge, and talks MQTT", () => {
    const t0 = Date.now();
    const vt = runUntil(() => serial.includes("mqtt rx"), 40_000);
    host.drain();
    const wall = Date.now() - t0;
    console.log(`net-probe: ${(vt / 1000).toFixed(1)} s virtual in ${(wall / 1000).toFixed(1)} s wall\n${serial.split("\n").filter((l) => /wifi|get1|blocked|secure|mqtt/.test(l)).join("\n")}`);
    expect(serial).toMatch(/wifi ip=10\.0\.2\.15 gw=10\.0\.2\.2 dns=10\.0\.2\.2 rssi=-55/);
    expect(serial).toMatch(/get1 200 \d+ms \{"temp_c":21\.5,"sky":"clear"\}/);
    expect(serial).toMatch(/blocked -1 /);
    expect(serial).toMatch(/secure 200 \d+ms \{"ok":true,"echoed":"\*+"\}/);
    expect(serial).toContain('mqtt rx devices/probe/cmd {"led":"on"}');
    // The key reached the API, and nothing the device or the tools see contains it.
    drainAuth();
    expect(upstreamAuth).toContain(SECRET);
    expect(serial).not.toContain(SECRET);
    const out = readNetwork(host, { limit: 200 });
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[secret:WEATHER_KEY]");
    const entries = out.entries as Array<{ kind: string; summary: string; why?: string; fix?: string; host?: string; secrets_used?: string[] }>;
    expect(entries.some((e) => e.kind === "wifi" && e.summary.includes('joined "JumperNet"'))).toBe(true);
    expect(entries.some((e) => e.kind === "dhcp" && e.summary.includes("10.0.2.15") && e.summary.includes(boardMac(1)))).toBe(true);
    const blocked = entries.find((e) => e.kind === "blocked" && e.host === "blocked.example.test");
    expect(blocked?.why).toContain("not on the project's allow list");
    expect(blocked?.fix).toBeTruthy();
    expect(entries.find((e) => e.host === "secure.api.test" && e.kind === "http")?.secrets_used).toEqual(["WEATHER_KEY"]);
    expect(entries.some((e) => e.kind === "mqtt")).toBe(true);
    expect(checkRequest(host, { host: "api.weather.test", path: "/v1/now", status: 200 }).ok).toBe(true);
    expect(checkRequest(host, { host: "blocked.example.test" })).toMatchObject({ ok: false, why: expect.stringContaining("blocked") });
  }, 180_000);

  it("drops the Wi-Fi on demand and the unmodified sketch reconnects by itself", () => {
    host.inject({ kind: "wifi_drop" });
    runUntil(() => /status [15]\n/.test(serial), 10_000);
    expect(serial).toMatch(/status 5\n/);
    runUntil(() => false, 3000);
    host.drain();
    expect(readNetwork(host, { kind: "wifi" }).entries).toContainEqual(expect.objectContaining({ summary: expect.stringContaining("could not join") }));
    host.inject({ kind: "weak_signal", rssi: -84 });
    host.clearFaults();
    host.inject({ kind: "weak_signal", rssi: -84 });
    runUntil(() => /again 200/.test(serial), 30_000);
    expect(serial).toMatch(/status 3\nrssi -84\n/);
    expect(serial).toMatch(/again 200 \d+ms \{"temp_c":21\.5/);
    host.drain();
    expect(readNetwork(host, { kind: "wifi" }).entries).toContainEqual(expect.objectContaining({ summary: expect.stringMatching(/joined "JumperNet" .*after \d+ refused attempt/) }));
  }, 120_000);
});
