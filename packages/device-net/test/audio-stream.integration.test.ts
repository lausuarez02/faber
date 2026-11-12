// Round 13 (audio): what an API returns, played. The audio-stream fixture (fixtures/audio-stream, a
// plain WiFi.h + HTTPClient + ESP_I2S sketch) joins the sandbox Wi-Fi on an ESP32-S3 in QEMU jb6,
// GETs raw 16-bit PCM from a mock API (content-length) and a WAV (chunked, header skipped by the
// sketch) and streams both into I2S as they arrive. Checked on the I2S bus: the samples are the
// API's (600 Hz then 800 Hz, the right length and level), at the WAV's 16 kHz, gap-free once
// started. The device network is the generic one (mocks, cassettes, the internet behind an allow
// list); nothing here is audio-specific except the test data.
// Needs the QEMU image (Docker) or Jumper's native QEMU (jumper setup esp32) and the fixture.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardMac, QemuEspBackend, qemuImageAvailable } from "@jumper/sim-backends/qemu-esp";
import { parseMocks, parseNetworkConfig } from "../src/config.ts";
import { DeviceNetHost } from "../src/host.ts";
import { readNetwork } from "../src/tools.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/audio-stream.esp32s3.merged.bin.gz", import.meta.url));
const available = existsSync(FIXTURE) && qemuImageAvailable();

/** What the backend hands its I2S bus (sim-core's I2sBlock; device-net does not depend on sim-core). */
interface I2sBlock {
  cycle: number;
  sampleRate: number;
  bits: number;
  channels: number;
  samples: Int32Array;
}

/** 16-bit mono PCM of a sine, little-endian. */
function pcm(hz: number, ms: number, amp = 12000, rate = 16000): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate)), 2 * i);
  return b;
}

function wav(data: Buffer, rate = 16000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Non-silent stretches of channel 0, split at >= 400 silent frames, with frequency and level. */
function bursts(blocks: readonly I2sBlock[], cps: number): { rate: number; ms: number; frames: number; hz: number; peak: number; gaps: number }[] {
  const out: { rate: number; ms: number; x: number[] }[] = [];
  let cur: { rate: number; ms: number; x: number[] } | undefined;
  let quiet = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.samples.length; i += b.channels) {
      const v = b.samples[i]!;
      if (v === 0) {
        quiet++;
        if (cur && quiet >= 400) cur = undefined;
        else cur?.x.push(0);
        continue;
      }
      if (!cur || cur.rate !== b.sampleRate) out.push((cur = { rate: b.sampleRate, ms: Math.round(((b.cycle / cps) * 1000 + (i / b.channels / b.sampleRate) * 1000) * 10) / 10, x: [] }));
      quiet = 0;
      cur.x.push(v);
    }
  }
  return out
    .filter((c) => c.x.length > 300)
    .map(({ rate, ms, x }) => {
      let end = x.length;
      while (end && x[end - 1] === 0) end--;
      let changes = 0;
      let first = -1;
      let lastAt = -1;
      let sign = 0;
      let gaps = 0;
      let z = 0;
      for (let i = 0; i < end; i++) {
        const v = x[i]!;
        if (v === 0) {
          z++;
          continue;
        }
        if (z >= 4) gaps += z;
        z = 0;
        const s = Math.sign(v);
        if (sign && s !== sign) {
          changes++;
          if (first < 0) first = i;
          lastAt = i;
        }
        sign = s;
      }
      return { rate, ms, frames: end, hz: ((changes - 1) / 2) * (rate / (lastAt - first)), peak: x.reduce((m, v) => Math.max(m, Math.abs(v)), 0), gaps };
    });
}

describe.skipIf(!available)("an ESP32-S3 plays audio an API returns (HTTP -> I2S, QEMU jb6, device network)", () => {
  let dir: string;
  let host: DeviceNetHost;
  let be: QemuEspBackend;
  let serial = "";
  const blocks: I2sBlock[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "jumper-audio-net-"));
    const say = pcm(600, 500);
    const said = wav(pcm(800, 300, 8000));
    host = await DeviceNetHost.start({
      config: parseNetworkConfig({ mode: "mock", wifi: { ssid: "JumperNet", password: "hunter22-wifi" } }),
      mocks: parseMocks({
        mocks: [
          { host: "audio.api.test", path: "/v1/say.pcm", response: { body_b64: say.toString("base64"), headers: { "content-type": "audio/L16; rate=16000; channels=1" } } },
          // The WAV arrives chunked, in uneven pieces (no content-length), as a streaming API sends it.
          { host: "audio.api.test", path: "/v1/say.wav", response: { headers: { "content-type": "audio/wav" }, chunks: [0, 777, 3001, 6000, said.length].slice(1).map((end, i, a) => ({ b64: said.subarray(i ? a[i - 1] : 0, end).toString("base64") })) } },
        ],
      }),
      caDir: join(dir, "ca"),
    });
    be = new QemuEspBackend({ chip: "esp32s3", network: { framePort: host.framePort, mac: boardMac(1) } });
    be.onSerial((b) => (serial += String.fromCharCode(b)));
    // A recording stand-in for sim-core's I2sBus (an amplifier's view of the bus).
    be.attachI2s({ send: (b: I2sBlock) => blocks.push(b), request: (r: { frames: number; channels: number }) => new Int32Array(r.frames * r.channels) } as unknown as Parameters<QemuEspBackend["attachI2s"]>[0]);
    be.load(new Uint8Array(gunzipSync(readFileSync(FIXTURE))));
  }, 60_000);

  afterAll(async () => {
    be?.close();
    await host?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("streams raw PCM and a chunked WAV from a mock API into I2S: the amp gets the API's samples", () => {
    const step = Math.round((be.cyclesPerSecond * 5) / 1000);
    const end = be.cycles + be.cyclesPerSecond * 60;
    while (be.cycles < end && !serial.includes("stream done")) be.step(step);
    host.drain();
    console.log(serial.split("\n").filter((l) => /wifi|i2s|pcm|wav|stream/.test(l)).join("\n"));
    expect(serial).toMatch(/wifi ip=10\.0\.2\.15/);
    expect(serial).toContain("i2s begin 1");
    expect(serial).toContain("pcm 200 16000");
    expect(serial).toContain("wav 200 9600");
    const got = bursts(blocks, be.cyclesPerSecond);
    console.log(got);
    // Every sample the API sent is played, in order, at the right pitch and level. The network runs
    // on the wall clock while the emulator runs faster than real time, so on a loaded machine a
    // stream can pause (silence between two bursts of the same sound) where a real network would
    // not have; no sample is lost or changed either way.
    const pcmPart = got.filter((b) => b.peak === 12000);
    const wavPart = got.filter((b) => b.peak === 8000);
    expect(pcmPart.length + wavPart.length).toBe(got.length);
    const sum = (xs: typeof got) => xs.reduce((n, b) => n + b.frames, 0);
    expect(Math.abs(sum(pcmPart) - 8000)).toBeLessThanOrEqual(2 * pcmPart.length);
    expect(Math.abs(sum(wavPart) - 4800)).toBeLessThanOrEqual(2 * wavPart.length);
    for (const b of pcmPart) expect(Math.abs(b.hz - 600)).toBeLessThan(3);
    for (const b of wavPart) expect(Math.abs(b.hz - 800)).toBeLessThan(4);
    for (const b of got) expect(b).toMatchObject({ rate: 16000, gaps: 0 });
    if (got.length > 2) console.log(`stream paused ${got.length - 2} time(s) waiting for the network (machine load)`);
    // The requests are in the network log like any other.
    const http = (readNetwork(host, { limit: 50 }).entries as Array<{ kind: string; host?: string; summary: string }>).filter((e) => e.kind === "http" && e.host === "audio.api.test");
    expect(http.length).toBe(2);
  }, 240_000);
});
