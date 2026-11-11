import { describe, expect, it } from "vitest";
import { devnetRows, fmtBytes, wifiSummary, type DevNetEntry } from "./devnet.ts";

const E: DevNetEntry[] = [
  { seq: 1, t_ms: 680, kind: "wifi", summary: 'joined "JumperNet" (RSSI -55 dBm)', source: "sandbox" },
  { seq: 2, t_ms: 690, kind: "dhcp", summary: "DHCP 10.0.2.15 for 02:4a:4d:00:00:01", source: "sandbox" },
  { seq: 3, t_ms: 700, kind: "dns", host: "api.weather.test", summary: "DNS api.weather.test → 198.18.0.1", source: "mock" },
  { seq: 4, t_ms: 1900, kind: "http", host: "api.weather.test", method: "GET", path: "/v1/now", status: 200, source: "internet", tls: "inspect", duration_ms: 31, bytes_in: 2048, secrets_used: ["WEATHER_KEY"], summary: "GET api.weather.test/v1/now → 200" },
  { seq: 5, t_ms: 2500, kind: "mqtt", host: "mqtt.example.test", open: false, frames: { out: 3, in: 2, bytes_out: 90, bytes_in: 40, samples: ["CONNECT probe", "PUBLISH devices/probe/telemetry"] }, summary: "MQTT mqtt.example.test" },
  { seq: 6, t_ms: 2600, kind: "blocked", host: "evil.example.test", why: "not on the allow list", fix: "add it", summary: "blocked: DNS evil.example.test" },
];

describe("device network panel model", () => {
  it("makes newest-first rows: requests with status, source, time, TLS and secret names; frames summarized; blocked with why / fix", () => {
    const rows = devnetRows(E);
    expect(rows.map((r) => r.label)).toEqual(["BLOCKED", "MQTT", "GET", "DNS", "DHCP", "Wi-Fi"]);
    const get = rows[2]!;
    expect(get).toMatchObject({ target: "api.weather.test/v1/now", status: "200", tone: "ok", secrets: ["WEATHER_KEY"] });
    expect(get.meta).toEqual(["internet", "31 ms", "2.0 KB", "TLS (sandbox CA)"]);
    expect(rows[1]!.frames).toBe("3 out · 2 in · 130 B");
    expect(rows[0]).toMatchObject({ tone: "err", why: "not on the allow list", fix: "add it" });
    expect(devnetRows(E, { events: false }).map((r) => r.label)).toEqual(["BLOCKED", "MQTT", "GET"]);
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("summarizes Wi-Fi from the boards and the faults", () => {
    expect(wifiSummary({ enabled: true, boards: [] }).text).toContain("no board");
    expect(wifiSummary({ enabled: true, boards: [{ mac: "x", ip: "10.0.2.15", ssid: "JumperNet", shim: true, joined: true }] })).toEqual({ text: '"JumperNet" · 10.0.2.15', tone: "ok" });
    expect(wifiSummary({ enabled: true, faults: [{ kind: "wifi_drop" }], boards: [] })).toEqual({ text: "Wi-Fi dropped (fault)", tone: "err" });
    expect(wifiSummary({ enabled: true, faults: [{ kind: "weak_signal", rssi: -88 }], boards: [{ mac: "x", ip: "10.0.2.15", shim: true, joined: true }] }).text).toContain("weak -88 dBm");
  });
});
