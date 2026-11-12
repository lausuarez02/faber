// Round 14: the ESP emulator keeps what the firmware wrote to flash across a reboot (power cycle,
// reset button) but a fresh run (reset) starts from the image; a seed fixes the chip's RNG (QEMU
// -seed), moving on per reboot. Checked with the scripted fake QEMU (no emulator needed).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { QemuEspBackend } from "./backend.ts";
import { qemuArgs, type QemuLaunchOptions, type QemuProcess } from "./launcher.ts";

const FAKE = fileURLToPath(new URL("./fake-qemu.mjs", import.meta.url));
const dirs: string[] = [];
const backends: QemuEspBackend[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function setup(opts: { seed?: number; persistFlash?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jumper-flash-seed-"));
  dirs.push(dir);
  const launches: QemuLaunchOptions[] = [];
  const launch = (o: QemuLaunchOptions): QemuProcess => {
    launches.push(o);
    // what the firmware wrote last boot: the fake "writes" by changing the flash file it was given
    const script = join(dir, `script-${launches.length}.json`);
    writeFileSync(script, JSON.stringify({ hello: "H jumper-esp32-bridge 6 esp32s3.gpio sync=1 feat=gpio", events: [] }));
    const child = spawn(process.execPath, [FAKE, String(o.bridgePort), script, join(dir, `rec-${launches.length}.json`)], { stdio: "ignore" });
    return { child, argv: qemuArgs(o, o.flashImage, "127.0.0.1"), stop: () => child.kill("SIGTERM") };
  };
  const be = new QemuEspBackend({ chip: "esp32s3", launch, timeoutMs: 10_000, ...opts });
  backends.push(be);
  return { be, launches };
}

const image = () => {
  const b = new Uint8Array(2 << 20).fill(0xff);
  b.set([0xe9, 1, 2, 3]);
  return b;
};

describe("flash and RNG seed across reboots", () => {
  it("keeps flash writes across reboot(), starts fresh on reset() and on a new image", () => {
    const { be, launches } = setup();
    be.load(image());
    const file = launches[0]!.flashImage;
    const written = readFileSync(file);
    written[0x300000 >> 1] = 0x42; // the firmware wrote a byte (e.g. LittleFS)
    writeFileSync(file, written);
    be.reboot();
    expect(launches[1]!.flashImage).toBe(file);
    expect(readFileSync(file)[0x300000 >> 1]).toBe(0x42);
    expect(be.readFlash()![0x300000 >> 1]).toBe(0x42);
    be.reset();
    expect(readFileSync(launches[2]!.flashImage)[0x300000 >> 1]).toBe(0xff);
    // QEMU writes to the file: no -snapshot
    expect(qemuArgs(launches[0]!, "f.bin", "h")).not.toContain("-snapshot");
  });

  it("persistFlash false boots every time from the image (QEMU -snapshot)", () => {
    const { be, launches } = setup({ persistFlash: false });
    be.load(image());
    const file = launches[0]!.flashImage;
    const w = readFileSync(file);
    w[10] = 0;
    writeFileSync(file, w);
    be.reboot();
    expect(readFileSync(launches[1]!.flashImage)[10]).toBe(0xff);
    expect(qemuArgs(launches[0]!, "f.bin", "h")).toContain("-snapshot");
  });

  it("a seed reaches QEMU (-seed), moves on per reboot and starts over on reset", () => {
    const { be, launches } = setup({ seed: 41 });
    be.load(image());
    be.reboot();
    be.reboot();
    be.reset();
    const seeds = launches.map((o) => {
      const a = qemuArgs(o, "f.bin", "h");
      return a[a.indexOf("-seed") + 1];
    });
    expect(seeds).toEqual(["41", "42", "43", "41"]);
    const none = setup();
    none.be.load(image());
    expect(qemuArgs(none.launches[0]!, "f.bin", "h")).not.toContain("-seed");
  });
});
