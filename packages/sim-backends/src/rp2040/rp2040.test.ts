// Unit tests for the rp2040js backend: Faber's ROM, the HEX/UF2 loaders, determinism, buses.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RP2040 } from "rp2040js";
import { I2cBus, SpiBus, type I2cDevice } from "@faber/sim-core";
import { createRp2040Backend } from "./backend.ts";
import { buildRomImage, installRom, ROM_BYTES } from "./rom.ts";
import { FirmwareImageError, parseRp2040Hex } from "./hex.ts";
import { hexToUf2 } from "./uf2.ts";
import { SoftI2cTarget } from "./soft-i2c.ts";
import { backendFactory } from "../index.ts";

const fixture = (n: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/${n}`, import.meta.url)), "utf8");

// ---------------------------------------------------------------- ROM

const view = new DataView(buildRomImage().buffer);
const u16 = (a: number) => view.getUint16(a, true);
const u32 = (a: number) => view.getUint32(a, true);
const code = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8);
function lookup(table: number, c: string): number {
  for (let p = table; u16(p); p += 4) if (u16(p) === code(c)) return u16(p + 2);
  return 0;
}

/** Call a ROM function the way firmware does: registers in, BKPT stub, BX LR back. */
function romCall(addr: number, regs: number[]): { r: Uint32Array; flags: { N: boolean; Z: boolean; C: boolean } } {
  const mcu = new RP2040();
  installRom(mcu, { cost: () => {}, halt: (r) => { throw new Error(r); } });
  const core = mcu.core;
  regs.forEach((v, i) => (core.registers[i] = v >>> 0));
  core.LR = 0x2000_0001; // return into SRAM
  core.PC = addr & ~1;
  for (let i = 0; i < 4 && core.PC !== 0x2000_0000; i++) core.executeInstruction();
  expect(core.PC).toBe(0x2000_0000);
  return { r: core.registers, flags: { N: core.N, Z: core.Z, C: core.C } };
}
const f32 = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0]!;
const fromF32 = (u: number) => new Float32Array(new Uint32Array([u]).buffer)[0]!;
const sf = (off: number) => u32(lookup(u16(0x16), "SF") + off);
const sd = (off: number) => u32(lookup(u16(0x16), "SD") + off);

describe("Faber's RP2040 ROM (no Raspberry Pi ROM code)", () => {
  it("has the layout the pico-sdk reads: magic, version 3, tables, lookup function", () => {
    expect(buildRomImage().length * 4).toBe(ROM_BYTES);
    expect([0x10, 0x11, 0x12].map((a) => view.getUint8(a))).toEqual([0x4d, 0x75, 0x01]);
    expect(view.getUint8(0x13)).toBe(3);
    expect(u32(4)).toBe(0x1000_0001); // reset → boot2 at the start of flash
    for (const c of ["MS", "MC", "S4", "C4", "P3", "R3", "L3", "T3", "IF", "EX", "FC", "CX", "RE", "RP", "UB"]) expect(lookup(u16(0x14), c), c).not.toBe(0);
    for (const c of ["SF", "SD", "CR", "GR"]) expect(lookup(u16(0x16), c), c).not.toBe(0);
    expect(view.getUint8(lookup(u16(0x16), "SF") - 2) * 4).toBe(0x80);
    // rom_table_lookup itself, called like the SDK does
    const lk = u16(0x18);
    expect(romCall(lk, [u16(0x14), code("MC")]).r[0]).toBe(lookup(u16(0x14), "MC"));
  });

  it("single precision rounds like IEEE-754 and flushes denormals", () => {
    expect(fromF32(romCall(sf(0x00), [f32(0.1), f32(0.2)]).r[0]!)).toBe(Math.fround(Math.fround(0.1) + Math.fround(0.2)));
    expect(fromF32(romCall(sf(0x0c), [f32(1), f32(3)]).r[0]!)).toBe(Math.fround(1 / 3));
    expect(romCall(sf(0x08), [f32(1e-30), f32(1e-10)]).r[0]).toBe(0); // 1e-40 is denormal → 0
  });

  it("float2int / float2fix round toward −∞ and clamp; fsin leaves the cosine in r1", () => {
    expect(romCall(sf(0x1c), [f32(-1.5)]).r[0]! | 0).toBe(-2);
    expect(romCall(sf(0x1c), [f32(3e9)]).r[0]).toBe(0x7fff_ffff);
    expect(romCall(sf(0x20), [f32(0.5), 16]).r[0]).toBe(0x8000);
    const { r } = romCall(sf(0x40), [f32(1)]);
    expect(fromF32(r[0]!)).toBeCloseTo(Math.sin(1), 6);
    expect(fromF32(r[1]!)).toBeCloseTo(Math.cos(1), 6);
  });

  it("int642float rounds a 64-bit integer once (no double rounding)", () => {
    // 2^60 + 2^36 + 1: just above half an ulp of a float at 2^60 → rounds up.
    const v = (1n << 60n) + (1n << 36n) + 1n;
    const r = romCall(sf(0x5c), [Number(v & 0xffff_ffffn), Number(v >> 32n)]).r[0]!;
    expect(fromF32(r)).toBe(2 ** 60 + 2 ** 37);
  });

  it("double precision add and double2float", () => {
    const d = new Float64Array([0.1, 0.2]);
    const w = new Uint32Array(d.buffer);
    const r = romCall(sd(0x00), [w[0]!, w[1]!, w[2]!, w[3]!]).r;
    expect(new Float64Array(new Uint32Array([r[0]!, r[1]!]).buffer)[0]).toBe(0.1 + 0.2);
    expect(fromF32(romCall(sd(0x7c), [w[0]!, w[1]!]).r[0]!)).toBe(Math.fround(0.1));
  });

  it("bit ops", () => {
    const fn = (c: string) => lookup(u16(0x14), c);
    expect(romCall(fn("P3"), [0xf0f0]).r[0]).toBe(8);
    expect(romCall(fn("L3"), [1]).r[0]).toBe(31);
    expect(romCall(fn("T3"), [0x80]).r[0]).toBe(7);
    expect(romCall(fn("R3"), [1]).r[0]).toBe(0x8000_0000);
  });
});

// ---------------------------------------------------------------- loaders

describe("firmware images", () => {
  it("loads arduino-pico Intel HEX into flash and refuses an AVR hex with why and fix", () => {
    const { used, image } = parseRp2040Hex(fixture("xiao_blink.hex"));
    expect(used).toBeGreaterThan(50_000);
    expect(image.length).toBe(2 * 1024 * 1024);
    let err: unknown;
    try {
      parseRp2040Hex(fixture("i2c_probe.hex"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FirmwareImageError);
    expect(String(err)).toMatch(/outside the RP2040's flash.*Why: this hex is an AVR image.*Fix: build this project's sketch again.*firmware\.build\.fqbn/);
  });

  it("writes a UF2 for the RPI-RP2 drive (family 0xE48BFF56, 256-byte payloads)", () => {
    const uf2 = hexToUf2(fixture("xiao_blink.hex"));
    const v = new DataView(uf2.buffer);
    expect(uf2.length % 512).toBe(0);
    expect(v.getUint32(12, true)).toBe(0x1000_0000);
    expect(v.getUint32(28, true)).toBe(0xe48bff56);
    expect(v.getUint32(24, true)).toBe(uf2.length / 512);
  });
});

// ---------------------------------------------------------------- backend

function runBlink(slices: number[]) {
  const be = createRp2040Backend({ board: "seeed-xiao-rp2040" });
  const edges: string[] = [];
  let serial = "";
  be.onPinChange((p, s, c) => {
    if (p === "GP26") edges.push(`${c}:${s.mode}:${s.value}`);
  });
  be.onSerial((b) => (serial += String.fromCharCode(b)));
  be.load(fixture("xiao_blink.hex"));
  for (const n of slices) be.step(n);
  return { be, edges, serial };
}

describe("rp2040js backend", { timeout: 60_000 }, () => {
  it("runs real firmware: USB serial, GPIO edges every 500 ms of virtual time", () => {
    const { be, edges, serial } = runBlink(Array(12).fill(125_000 * 100));
    expect(be.cycles).toBeGreaterThanOrEqual(125_000 * 1200);
    expect(serial).toContain("LED off 500\r\nLED on 1\r\n");
    const highs = edges.filter((e) => e.endsWith("output:1")).map((e) => Number(e.split(":")[0]));
    expect(highs.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(highs[1]! - highs[0]! - 125_000_000)).toBeLessThan(125_000 * 1.5);
  });

  it("is deterministic whatever the step sizes", () => {
    const a = runBlink([125_000 * 1100]);
    const b = runBlink(Array(1100).fill(125_000));
    expect(a.edges).toEqual(b.edges);
    expect(a.serial).toBe(b.serial);
  });

  it("reset restarts the firmware from cycle 0; stopAt ends a step early", () => {
    const { be } = runBlink([125_000 * 300]);
    be.reset();
    expect(be.cycles).toBe(0);
    be.onPinChange((_p, _s, c) => be.stopAt!(c));
    be.step(125_000 * 100);
    expect(be.cycles).toBeLessThan(125_000 * 100);
  });

  it("I2C: the OLED sketch talks to a device on the board's Wire pins (I2C1 on a XIAO)", () => {
    const be = createRp2040Backend({ board: "seeed-xiao-rp2040" });
    const bus = new I2cBus("i2c0", () => be.cycles);
    const writes: number[] = [];
    const dev: I2cDevice = { i2cAddress: () => 0x3c, i2cConnect: () => true, i2cWrite: (b) => (writes.push(b), true), i2cRead: () => 0, i2cStop: () => {} };
    bus.attach("oled", dev);
    be.attachI2c!(bus);
    be.load(fixture("xiao_oled.hex"));
    be.step(125_000 * 300);
    expect(writes.length).toBeGreaterThan(1000); // init sequence + a 1 KB frame
    expect(bus.transactions().every((t) => t.address === 0x3c && t.ack)).toBe(true);
  });

  it("SPI: bytes reach a selected device and its MISO comes back", () => {
    const be = createRp2040Backend({ board: "seeed-xiao-rp2040" });
    const spi = new SpiBus();
    const got: number[] = [];
    spi.attach("dev", { spiTransfer: (b) => (got.push(b), 0x42) }, () => true);
    be.attachSpi!(spi);
    let serial = "";
    be.onSerial((b) => (serial += String.fromCharCode(b)));
    be.load(fixture("xiao_io_probe.hex"));
    be.step(125_000 * 250);
    expect(got.slice(0, 3)).toEqual([0x9f, 0, 0]);
    expect(serial).toContain("spi 42 42 42");
  });

  it("ADC: GP28 at 1.65 V reads half scale (10-bit analogRead)", () => {
    const be = createRp2040Backend({ board: "seeed-xiao-rp2040" });
    let serial = "";
    be.onSerial((b) => (serial += String.fromCharCode(b)));
    be.load(fixture("xiao_io_probe.hex"));
    be.setPinInput("GP28", 1.65);
    be.step(125_000 * 250);
    expect(serial).toMatch(/adc 51[0-3]/);
  });

  it("the factory picks the backend from mcu.backend and refuses unknown RP2040 boards with a fix", () => {
    const be = backendFactory({ partId: "pico", type: "raspberry-pi-pico", mcu: { backend: "rp2040js", chip: "rp2040", clockHz: 125e6, vcc: 3.3 } });
    expect(be.pinIds).toHaveLength(30);
    expect(be.busPins?.i2c).toEqual({ sda: "GP4", scl: "GP5" });
    expect(() => backendFactory({ partId: "x", type: "adafruit-feather-rp2040", mcu: { backend: "rp2040js", chip: "rp2040", clockHz: 125e6, vcc: 3.3 } })).toThrow(/Fix:/);
  });
});

describe("bit-level I2C target (arduino-pico's Wire address probe)", () => {
  it("decodes START + address, ACKs by pulling SDA low on the 9th clock, then STOP", () => {
    const bus = new I2cBus();
    bus.attach("imu", { i2cAddress: () => 0x68, i2cConnect: () => true, i2cWrite: () => true, i2cRead: () => 0, i2cStop: () => {} });
    const t = new SoftI2cTarget(() => bus);
    t.update(1, 1);
    t.update(0, 1); // START
    t.update(0, 0);
    const byte = (0x68 << 1) | 0;
    for (let i = 7; i >= 0; i--) {
      const b = ((byte >> i) & 1) as 0 | 1;
      t.update(b, 0);
      t.update(b, 1);
      t.update(b, 0);
    }
    t.update(1, 0); // master releases SDA for the ACK
    expect(t.line(1)).toBe(0); // device ACK
    t.update(1, 1);
    t.update(1, 0);
    expect(t.line(1)).toBe(1);
    t.update(0, 0);
    t.update(0, 1);
    t.update(1, 1); // STOP
    expect(bus.transactions()).toMatchObject([{ address: 0x68, read: false, ack: true, count: 0 }]);
  });
});
