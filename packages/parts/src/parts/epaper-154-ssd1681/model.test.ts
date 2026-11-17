import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { need } from "../../lib/bench.ts";
import { timedMount } from "../../lib/timedBench.ts";

const def = need(registry.get("epaper-154-ssd1681"), "epaper-154-ssd1681");
const wiring = { VCC: "vcc", GND: GROUND, DC: "dc", RST: "rst", BUSY: "busy" };

function rig() {
  const b = timedMount(def, { wiring });
  let dc: 0 | 1 = 1;
  (b.ctx as { digital?: (pin: string) => 0 | 1 }).digital = (pin) => (pin === "DC" ? dc : (b.result?.voltage(b.ctx.node(pin)) ?? 3.3) > 1.6 ? 1 : 0);
  b.set("vcc", 3.3);
  const cmd = (c: number, ...data: number[]) => {
    dc = 0;
    b.model.spi!.spiTransfer(c);
    dc = 1;
    for (const d of data) b.model.spi!.spiTransfer(d);
  };
  /** GxEPD2-style: window = whole screen, then the RAM bytes. */
  const image = (ram: 0x24 | 0x26, px: (x: number, y: number) => boolean) => {
    cmd(0x11, 0x03);
    cmd(0x44, 0, 24);
    cmd(0x45, 0, 0, 199, 0);
    cmd(0x4e, 0);
    cmd(0x4f, 0, 0);
    const bytes: number[] = [];
    for (let y = 0; y < 200; y++)
      for (let xb = 0; xb < 25; xb++) {
        let v = 0;
        for (let k = 0; k < 8; k++) if (!px(xb * 8 + k, y)) v |= 0x80 >> k; // 1 = white
        bytes.push(v);
      }
    cmd(ram, ...bytes);
  };
  const init = () => {
    cmd(0x12);
    b.advance(20);
    cmd(0x01, 0xc7, 0, 0);
    cmd(0x3c, 0x05);
    cmd(0x18, 0x80);
  };
  const st = () => b.model.visualState();
  return { b, cmd, image, init, st };
}

const square = (x: number, y: number) => x >= 50 && x < 150 && y >= 50 && y < 150; // 10 000 px
const dot = (x: number, y: number) => x >= 0 && x < 10 && y >= 0 && y < 10; // 100 px

describe("epaper-154-ssd1681", () => {
  it("drawing changes nothing until a full refresh, which holds BUSY high ~2 s and then shows the image", () => {
    const { b, cmd, image, init, st } = rig();
    init();
    image(0x24, square);
    expect(st()).toMatchObject({ lit: 0, pending: true });
    cmd(0x22, 0xf7);
    cmd(0x20);
    expect(b.solve().voltage("busy")).toBeCloseTo(3.3, 1);
    expect(st()).toMatchObject({ refreshing: true, settling: true, current_ma: 8 });
    b.advance(1900);
    expect(st().lit).toBe(0); // still refreshing
    b.advance(200);
    expect(b.solve().voltage("busy")).toBeLessThan(0.05);
    expect(st()).toMatchObject({ lit: 10_000, fullRefreshes: 1, pending: false, analogOn: false, settling: false });
    // 0xF7 turns the supplies off at the end: the module idles at microamps
    expect(st().current_ma as number).toBeLessThan(0.05);
    const f = b.model.framebuffer!();
    expect(f.data[100 * 200 + 100]).toBe(0x0000);
    expect(f.data[0]).toBe(0xffff);
  });

  it("a partial refresh only redraws pixels that differ from the previous-image RAM: ghosts when 0x26 is stale", () => {
    const { b, cmd, image, init, st } = rig();
    init();
    image(0x24, square);
    cmd(0x22, 0xf7);
    cmd(0x20);
    b.advance(2100);
    // the right way (GxEPD2): previous image in 0x26, new in 0x24, partial refresh
    image(0x26, square);
    image(0x24, dot);
    cmd(0x22, 0xfc);
    cmd(0x20);
    b.advance(600);
    expect(st()).toMatchObject({ lit: 100, partialRefreshes: 1, ghostPixels: 0, analogOn: true });
    // the wrong way: 0x26 still holds the square, the glass shows the dot; draw the square again
    image(0x24, square);
    cmd(0x22, 0xfc);
    cmd(0x20);
    b.advance(600);
    // pixels where new == "previous" (the square) are not driven: the square is not drawn
    expect(st().lit).toBe(100);
    expect(st().ghostPixels).toBe(10_000 + 100); // the square missing, the dot still there
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("epaper-ghosting");
  });

  it("deep sleep (0x10) ignores everything until a hardware reset; the image stays; bytes during BUSY are flagged", () => {
    const { b, cmd, image, init, st } = rig();
    init();
    image(0x24, dot);
    cmd(0x22, 0xf7);
    cmd(0x20);
    cmd(0x11, 0x03); // too early: BUSY is high
    b.advance(2100);
    cmd(0x10, 0x01);
    expect(st()).toMatchObject({ sleeping: true, lit: 100 });
    expect(st().current_ma as number).toBeLessThanOrEqual(0.001);
    image(0x24, square);
    expect(st().pending).toBe(false);
    const codes = b.model.diagnostics!().map((d) => d.code);
    expect(codes).toContain("epaper-asleep");
    expect(codes).toContain("epaper-busy-ignored");
    b.set("rst", 0);
    b.set("rst", 3.3);
    expect(st().sleeping).toBe(false);
    // power off: the glass keeps the image
    b.set("vcc", 0);
    expect(st()).toMatchObject({ lit: 100, on: true });
  });

  it("a refresh with the panel supplies off does nothing and says why", () => {
    const { b, cmd, image, init, st } = rig();
    init();
    image(0x24, square);
    cmd(0x22, 0x04);
    cmd(0x20);
    b.advance(50);
    expect(st().lit).toBe(0);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("epaper-unpowered-refresh");
  });

  it("follows the data entry mode: X decrementing writes right to left", () => {
    const { b, cmd, st } = rig();
    cmd(0x11, 0x02); // X-, Y+
    cmd(0x44, 24, 0);
    cmd(0x45, 0, 0, 199, 0);
    cmd(0x4e, 24);
    cmd(0x4f, 0, 0);
    cmd(0x24, 0x00); // 8 black pixels at the right end of row 0
    cmd(0x22, 0xf7);
    cmd(0x20);
    b.advance(2100);
    const f = b.model.framebuffer!();
    expect(f.data[199]).toBe(0);
    expect(f.data[0]).toBe(0xffff);
    expect(st().lit).toBe(8);
  });
});
