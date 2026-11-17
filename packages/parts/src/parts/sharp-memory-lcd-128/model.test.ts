import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { need } from "../../lib/bench.ts";
import { timedMount } from "../../lib/timedBench.ts";

const def = need(registry.get("sharp-memory-lcd-128"), "sharp-memory-lcd-128");

function rig() {
  const b = timedMount(def, { wiring: { VIN: "vcc", GND: GROUND, DISP: "disp" } });
  (b.ctx as { digital?: (pin: string) => 0 | 1 }).digital = (pin) => ((b.result?.voltage(b.ctx.node(pin)) ?? 0) > 1.5 ? 1 : 0);
  b.set("vcc", 3.3);
  b.set("disp", 3.3);
  const frame = (bytes: number[]) => {
    b.model.spi!.spiSelect!(true);
    for (const x of bytes) b.model.spi!.spiTransfer(x);
    b.model.spi!.spiSelect!(false);
  };
  /** Adafruit_SharpMem refresh(): LSB-first bytes, line + 1, 16 bytes, dummy; trailing dummy. */
  const lines = (vcom: number, rows: number[], px: (x: number, y: number) => boolean) => {
    const out = [0x01 | (vcom << 1)];
    for (const y of rows) {
      out.push(y + 1);
      for (let i = 0; i < 16; i++) {
        let v = 0;
        for (let k = 0; k < 8; k++) if (px(i * 8 + k, y)) v |= 1 << k; // black bits
        out.push(v ^ 0xff);
      }
      out.push(0);
    }
    out.push(0);
    frame(out);
  };
  return { b, frame, lines, st: () => b.model.visualState() };
}

describe("sharp-memory-lcd-128", () => {
  it("writes lines (LSB first, 1 = white) and shows them at once", () => {
    const { b, lines, st } = rig();
    lines(0, [10, 11], (x) => x < 16);
    expect(st()).toMatchObject({ lit: 32, linesWritten: 2, on: true });
    const f = b.model.framebuffer!();
    expect(f.data[10 * 128 + 0]).toBe(0);
    expect(f.data[10 * 128 + 16]).toBe(0xffff);
    expect(f.data[0]).toBe(0xffff);
  });

  it("understands a sender that uses MSB-first bit order; clear-all empties it; DISP low hides it", () => {
    const { lines, frame, st, b } = rig();
    const rev = (v: number) => {
      let r = 0;
      for (let i = 0; i < 8; i++) if (v & (1 << i)) r |= 0x80 >> i;
      return r;
    };
    // the same frame bit-reversed: command 0x80, line 1 → 0x80...
    frame([0x80, rev(1), ...Array(16).fill(0x00), 0, 0]);
    expect(st().lit).toBe(128);
    frame([0x04, 0]);
    expect(st()).toMatchObject({ lit: 0, clears: 1 });
    lines(1, [0], () => true);
    b.set("disp", 0);
    expect(st()).toMatchObject({ on: false, lit: 0 });
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("memlcd-disp-low");
  });

  it("warns when VCOM is not toggled about once a second, and is quiet when it is", () => {
    const { b, lines } = rig();
    lines(0, [0], () => true);
    for (let i = 1; i <= 10; i++) {
      b.advance(1000);
      lines(i % 2, [0], () => true);
    }
    expect(b.model.diagnostics!().map((d) => d.code)).not.toContain("memlcd-vcom");
    b.advance(8000);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("memlcd-vcom");
  });

  it("draws about 2 µA for a still image; loses the image without power", () => {
    const { b, lines, st } = rig();
    lines(0, [0], () => true);
    b.advance(2000);
    expect(st().current_ua).toBe(2);
    b.set("vcc", 0);
    b.set("vcc", 3.3);
    expect(st().lit).toBe(0);
  });
});
