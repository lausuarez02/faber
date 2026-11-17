import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashString, type McuBackend, type PinState } from "@faber/sim-core";
import { backendFactory, boardPinMap, createAvrBackend, createBackend } from "./index.ts";

/** Golden firmware built by scripts/build-firmware.sh (see examples/blink/firmware/BUILD.md). */
const BLINK_HEX = readFileSync(
  fileURLToPath(new URL("../../../examples/blink/firmware/build/blink.ino.hex", import.meta.url)),
  "utf8",
);
const HZ = 16_000_000;
const msToCycles = (ms: number) => Math.round((ms * HZ) / 1000);

interface Trace {
  pins: { pin: string; mode: string; value: number; cycle: number }[];
  serial: { byte: number; cycle: number }[];
}

function run(backend: McuBackend, ms: number, chunkMs = 1): Trace {
  const trace: Trace = { pins: [], serial: [] };
  backend.onPinChange((pin, s: PinState, cycle) => trace.pins.push({ pin, mode: s.mode, value: s.value, cycle }));
  backend.onSerial((byte, cycle) => trace.serial.push({ byte, cycle }));
  const target = msToCycles(ms);
  const chunk = msToCycles(chunkMs);
  while (backend.cycles < target) backend.step(Math.min(chunk, target - backend.cycles));
  return trace;
}

function hashTrace(t: Trace): string {
  return hashString(JSON.stringify(t));
}

// Multi-second firmware runs: give them room when the whole suite shares the CPU.
describe("avr8js backend: golden Blink firmware", { timeout: 60_000 }, () => {
  it("toggles D13 every 1000 ms (±1 ms) after startup", () => {
    const mcu = createBackend("uno");
    mcu.load(BLINK_HEX);
    const t = run(mcu, 3500);
    const d13 = t.pins.filter((p) => p.pin === "D13");
    // First event: pinMode(OUTPUT) (output low), then HIGH, LOW, HIGH, LOW within 3.5 s.
    expect(d13[0]).toMatchObject({ mode: "output", value: 0 });
    const edges = d13.filter((p) => p.mode === "output").slice(1);
    expect(edges.map((e) => e.value)).toEqual([1, 0, 1, 0]);
    // Startup: first HIGH within a few ms of reset (no bootloader in the image).
    expect(edges[0]!.cycle).toBeLessThan(msToCycles(5));
    for (let i = 1; i < edges.length; i++) {
      const dtMs = ((edges[i]!.cycle - edges[i - 1]!.cycle) * 1000) / HZ;
      expect(Math.abs(dtMs - 1000)).toBeLessThanOrEqual(1);
    }
    expect(mcu.readPin("D13")).toEqual({ mode: "output", value: 0 });
  });

  it("prints the exact serial sequence", () => {
    const mcu = createBackend("uno");
    mcu.load(BLINK_HEX);
    const t = run(mcu, 3500);
    const text = String.fromCharCode(...t.serial.map((s) => s.byte));
    expect(text).toBe("LED on\r\nLED off\r\nLED on\r\nLED off\r\n");
    // Bytes leave in cycle order, 115200 baud ≈ 87 µs/byte at the very least apart.
    for (let i = 1; i < t.serial.length; i++) expect(t.serial[i]!.cycle).toBeGreaterThan(t.serial[i - 1]!.cycle);
  });

  it("is deterministic: same trace hash across runs and step sizes", () => {
    const a = createBackend("uno");
    a.load(BLINK_HEX);
    const b = createAvrBackend();
    b.load(BLINK_HEX);
    const ha = hashTrace(run(a, 2500, 1));
    const hb = hashTrace(run(b, 2500, 7.3));
    expect(ha).toBe(hb);
    // reset() replays identically too.
    a.reset();
    expect(a.cycles).toBe(0);
    expect(hashTrace(run(a, 2500, 3))).toBe(ha);
  });

  it("speed: simulated seconds per wall second", () => {
    const mcu = createBackend("uno");
    mcu.load(BLINK_HEX);
    const simMs = 3000;
    const t0 = performance.now();
    run(mcu, simMs, 1);
    const wallS = (performance.now() - t0) / 1000;
    const ratio = simMs / 1000 / wallS;
    console.log(`[avr8js] blink: ${(simMs / 1000).toFixed(1)} s simulated in ${wallS.toFixed(3)} s wall → ${ratio.toFixed(2)}x real time`);
    expect(ratio).toBeGreaterThan(0.25); // generous floor so CI on slow runners stays green; target is ≥ 1x
  });
});

describe("avr8js backend: pins, ADC, factory", () => {
  it("exposes Uno pin ids and maps Nano A6/A7 as analog-only", () => {
    expect(createBackend("arduino-uno").pinIds).toEqual([
      ...Array.from({ length: 14 }, (_, i) => `D${i}`),
      ...Array.from({ length: 6 }, (_, i) => `A${i}`),
    ]);
    const nano = createBackend("nano");
    expect(nano.pinIds).toContain("A7");
    expect(nano.readPin("A6")).toEqual({ mode: "analog", value: 0 });
    expect(boardPinMap("uno").find((p) => p.id === "D13")).toEqual({ id: "D13", port: "B", bit: 5 });
    expect(boardPinMap("uno").find((p) => p.id === "D7")).toEqual({ id: "D7", port: "D", bit: 7 });
    expect(boardPinMap("uno").find((p) => p.id === "A2")).toEqual({ id: "A2", port: "C", bit: 2, adc: 2 });
  });

  it("setPinInput thresholds to the PIN register with hysteresis and never fires onPinChange", () => {
    const mcu = createBackend("uno");
    let fired = 0;
    mcu.onPinChange(() => fired++);
    expect(mcu.readPin("D2")).toEqual({ mode: "input", value: 0 });
    mcu.setPinInput("D2", 4.0);
    expect(mcu.readPin("D2").value).toBe(1);
    mcu.setPinInput("D2", 2.0); // between VIL (1.5) and VIH (3.0): keeps last level
    expect(mcu.readPin("D2").value).toBe(1);
    mcu.setPinInput("D2", 1.0);
    expect(mcu.readPin("D2").value).toBe(0);
    expect(fired).toBe(0);
    expect(() => mcu.readPin("D99")).toThrow(/unknown pin 'D99'/);
  });

  it("reports pin modes from DDR/PORT and feeds the ADC from A0..A5 (AVCC = vcc)", () => {
    // Hand-assembled program:
    //   sbi DDRB,5 ; sbi PORTD,2 (pull-up on D2) ; ADMUX = 0x43 (AVCC ref, ADC3) ;
    //   ADCSRA = 0xC7 (enable + start, /128) ; loop: lds r16,ADCSRA ; sbrc r16,6 ; rjmp loop ;
    //   lds r24,ADCL ; lds r25,ADCH ; out GPIOR1,r24 ; out GPIOR2,r25 ; rjmp .-2
    const words = [
      0x9a25, // sbi 0x04(DDRB),5
      0x9a5a, // sbi 0x0b(PORTD),2
      0xe403, // ldi r16,0x43
      0x9300, 0x007c, // sts ADMUX,r16
      0xec07, // ldi r16,0xC7
      0x9300, 0x007a, // sts ADCSRA,r16
      0x9100, 0x007a, // lds r16,ADCSRA
      0xfd06, // sbrc r16,6
      0xcffc, // rjmp -4 (back to lds)
      0x9180, 0x0078, // lds r24,ADCL
      0x9190, 0x0079, // lds r25,ADCH
      0xbd8a, // out 0x2a(GPIOR1),r24
      0xbd9b, // out 0x2b(GPIOR2),r25
      0xcfff, // rjmp .-2
    ];
    const image = new Uint8Array(words.length * 2);
    words.forEach((w, i) => {
      image[i * 2] = w & 0xff;
      image[i * 2 + 1] = w >> 8;
    });
    const mcu = createBackend("uno");
    const events: { pin: string; mode: string; cycle: number }[] = [];
    mcu.onPinChange((pin, s, cycle) => events.push({ pin, mode: s.mode, cycle }));
    mcu.setPinInput("A3", 2.5);
    mcu.load(image); // load resets; external inputs are re-applied to the fresh chip
    mcu.step(20_000);
    expect(mcu.readPin("D13")).toEqual({ mode: "output", value: 0 });
    expect(mcu.readPin("D2").mode).toBe("input_pullup");
    expect(mcu.readPin("D3").mode).toBe("input");
    expect(events.map((e) => `${e.pin}:${e.mode}`)).toEqual(["D13:output", "D2:input_pullup"]);
    expect(events[0]!.cycle).toBeLessThan(events[1]!.cycle);
    expect(events[1]!.cycle).toBeLessThan(10);
    // Read back the conversion via a tiny peek: GPIOR1/GPIOR2 = ADCL/ADCH.
    const adc = peekAdcResult(mcu);
    expect(adc).toBeGreaterThanOrEqual(510);
    expect(adc).toBeLessThanOrEqual(513);
  });

  it("backendFactory builds avr8js boards and rejects unknown backends readably", () => {
    const mcu = backendFactory({
      partId: "uno",
      type: "arduino-uno",
      mcu: { backend: "avr8js", chip: "atmega328p", clockHz: 16_000_000, vcc: 5 },
    });
    expect(mcu.cyclesPerSecond).toBe(16_000_000);
    expect(mcu.vcc).toBe(5);
    expect(() =>
      backendFactory({ partId: "b", type: "esp32", mcu: { backend: "qemu", chip: "esp32", clockHz: 1, vcc: 3.3 } }),
    ).toThrow(/no simulator backend 'qemu'/);
    expect(() => createBackend("pico")).toThrow(/supported: uno, nano/);
  });
});

/** Test-only: read the 10-bit ADC result the program copied into GPIOR1/GPIOR2 (data addresses 0x4a/0x4b). */
function peekAdcResult(mcu: McuBackend): number {
  const data = (mcu as unknown as { m: { cpu: { data: Uint8Array } } }).m.cpu.data;
  return data[0x4a]! | (data[0x4b]! << 8);
}
