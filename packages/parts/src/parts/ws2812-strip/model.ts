// WS2812B chain. The data line is decoded from the MCU's own pin edges (ctx.watch, called inside
// the MCU step at the exact cycle): each HIGH pulse is a bit, 0 when it is short (≤ 0.6 µs) and
// 1 when it is long; 24 bits per LED in G, R, B order, MSB first; the first 24 bits go to the
// first LED, the next to the second, and so on. A LOW of ≥ 50 µs (reset) latches what was sent;
// LEDs that got no new bits keep their colour. Pulses outside the datasheet windows (T0H 0.22–0.55
// µs, T1H 0.58–1.0 µs: the union of the WS2812B datasheet, 0.4 / 0.8 µs ± 150 ns, and the
// WS2812B-V5 one, T0H 220–380 ns, T1H 580 ns–1 µs, which the RP2040 PIO drivers of FastLED and
// Adafruit NeoPixel aim for) are still decoded but reported.
import type { Diagnostic, PartModel, PartModelFactory } from "@faber/sim-core";
import { GROUND } from "@faber/sim-core";
import { clamp, num, round, str } from "../../lib/props.ts";

export const MAX_LEDS = 16;
export const BIT_THRESHOLD_US = 0.6;
export const RESET_US = 50;
const T0H = [0.22, 0.55];
const T1H = [0.58, 1.0];
const MIN_VCC = 3.5;
/** Per channel at full brightness, and the idle current of each LED's driver. */
const CHANNEL_MA = 20;
const IDLE_MA = 1;
const OFF = "#2B313B";

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
export const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();

/** The colour an LED shows: its hue at full brightness (glow carries the brightness). */
function shown(r: number, g: number, b: number): { fill: string; glow: number } {
  const m = Math.max(r, g, b);
  if (m === 0) return { fill: OFF, glow: 0 };
  const k = 255 / m;
  return { fill: rgbHex(Math.round(r * k), Math.round(g * k), Math.round(b * k)), glow: round(0.25 + (0.75 * m) / 255, 3) };
}

export const create: PartModelFactory = (ctx): PartModel => {
  let count = clamp(Math.round(num(ctx.props.count, 8)), 1, MAX_LEDS);
  /** Latched colours, [r, g, b] per LED. */
  const leds: [number, number, number][] = Array.from({ length: MAX_LEDS }, () => [0, 0, 0]);
  /** Bytes received since the last latch. */
  let rx: number[] = [];
  let cur = 0;
  let nbits = 0;
  let riseMs: number | undefined;
  let lastFallMs: number | undefined;
  let frames = 0;
  let badBits = 0;
  let lastBadUs = 0;
  let vcc = 0;
  let powered = false;
  let extraBits = 0;

  const latch = () => {
    if (rx.length === 0 && nbits === 0) return;
    const n = Math.min(count, Math.floor(rx.length / 3));
    for (let i = 0; i < n; i++) leds[i] = [rx[i * 3 + 1]!, rx[i * 3]!, rx[i * 3 + 2]!];
    extraBits = Math.max(0, rx.length * 8 + nbits - count * 24);
    rx = [];
    cur = 0;
    nbits = 0;
    frames++;
    ctx.requestSolve();
  };

  const bit = (b: 0 | 1) => {
    cur = (cur << 1) | b;
    nbits++;
    if (nbits === 8) {
      if (rx.length < MAX_LEDS * 3 + 3) rx.push(cur);
      cur = 0;
      nbits = 0;
    }
  };

  ctx.watch?.("DIN", (level, tMs) => {
    if (!powered) return;
    if (level === 1) {
      if (lastFallMs !== undefined && (tMs - lastFallMs) * 1000 >= RESET_US) latch();
      riseMs = tMs;
    } else if (riseMs !== undefined) {
      const us = (tMs - riseMs) * 1000;
      const b: 0 | 1 = us > BIT_THRESHOLD_US ? 1 : 0;
      const [lo, hi] = b ? T1H : T0H;
      // 1 ns of slack: edge times are float ms, and a T0H of exactly 0.22 µs must pass.
      if (us < lo! - 0.001 || us > hi! + 0.001) {
        badBits++;
        lastBadUs = us;
      }
      bit(b);
      lastFallMs = tMs;
      riseMs = undefined;
    }
  });

  const currentMa = () => {
    let ma = count * IDLE_MA;
    for (let i = 0; i < count; i++) ma += ((leds[i]![0] + leds[i]![1] + leds[i]![2]) / 255) * CHANNEL_MA;
    return ma;
  };

  return {
    stamp(c) {
      const v = Math.max(vcc, 5);
      c.resistor(ctx.node("VCC"), GROUND, v / (currentMa() / 1000), { id: "leds" });
      c.resistor(ctx.node("DIN"), GROUND, 1e6, { id: "din" });
    },
    onSolved(r) {
      vcc = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      const p = vcc >= MIN_VCC;
      if (p !== powered) {
        powered = p;
        if (!p) {
          for (const l of leds) l.fill(0);
          rx = [];
          nbits = 0;
          riseMs = undefined;
          lastFallMs = undefined;
        }
      }
    },
    tick(tMs) {
      // The final frame is latched by the line staying LOW for 50 µs.
      if ((rx.length > 0 || nbits > 0) && lastFallMs !== undefined && (tMs - lastFallMs) * 1000 >= RESET_US && riseMs === undefined) latch();
    },
    visualState() {
      const s: Record<string, string | number | boolean> = {};
      let lit = 0;
      const colors: string[] = [];
      for (let i = 0; i < MAX_LEDS; i++) {
        const [r, g, b] = i < count && powered ? leds[i]! : [0, 0, 0];
        const v = shown(r, g, b);
        s[`led${i}`] = v.fill;
        s[`glow${i}`] = v.glow;
        s[`show${i}`] = i < count;
        if (i < count) {
          colors.push(rgbHex(r, g, b));
          if (r + g + b > 0) lit++;
        }
      }
      const ma = round(powered ? currentMa() : 0, 1);
      s.tapeWidth = count * 20 + 4;
      s.count = count;
      s.colors = colors.join(" ");
      s.lit = lit;
      s.frames = frames;
      s.currentmA = ma;
      s.label = `${count} LED${count === 1 ? "" : "s"} · ${Math.round(ma)} mA`;
      return s;
    },
    setProp(id, v) {
      if (id === "count") count = clamp(Math.round(num(v, count)), 1, MAX_LEDS);
    },
    interact(e) {
      // set key "colors": "#FF0000 #00FF00 …" paints the LEDs directly (tests, demos without firmware).
      if (e.kind === "set" && e.key === "colors") {
        const list = str(typeof e.value === "string" ? e.value : "", "").split(/[\s,]+/).filter(Boolean);
        list.slice(0, MAX_LEDS).forEach((h, i) => {
          const m = /^#?([0-9a-f]{6})$/i.exec(h);
          if (!m) return;
          const n = parseInt(m[1]!, 16);
          leds[i] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
        });
        frames++;
      }
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      const ma = currentMa();
      if (vcc > 5.6) out.push({ severity: "error", code: "ws2812-overvoltage", pin: "VCC", message: `${id} gets ${vcc.toFixed(1)} V on 5V; WS2812B LEDs die above ~5.3–6 V. Power it from 5 V.` });
      else if (!powered && vcc > 0.3) out.push({ severity: "warning", code: "ws2812-undervoltage", pin: "VCC", message: `${id} gets only ${vcc.toFixed(1)} V (needs 3.5 to 5.3 V), so the LEDs stay dark. Wire 5V → 5 V.` });
      if (badBits > 0) {
        out.push({
          severity: "warning",
          code: "ws2812-timing",
          pin: "DIN",
          message: `${id}: ${badBits} data bit(s) had a HIGH time outside the WS2812B windows (last ${lastBadUs.toFixed(2)} µs; 0 = 0.22–0.55 µs, 1 = 0.58–1.0 µs). Real LEDs may show wrong colours or flicker. Use a WS2812 library (FastLED, Adafruit NeoPixel) on a 16 MHz board and keep interrupts off while sending.`,
        });
      }
      if (ma > 400) {
        out.push({
          severity: "warning",
          code: "ws2812-current",
          pin: "VCC",
          message: `${id} draws about ${Math.round(ma)} mA for these colours. A board's 5V pin on USB gives 400–500 mA in all, so the board resets or the colours brown out. Feed the strip from its own 5 V supply (≥ ${Math.ceil(ma / 100) * 100} mA, shared GND) or lower the brightness.`,
        });
      }
      if (extraBits > 0 && frames > 0) {
        out.push({ severity: "info", code: "ws2812-more-data", message: `${id}: the firmware sent ${extraBits / 24} more LED(s) than the ${count} in this chain; they went out of the last LED's DOUT. Set count to the real number of LEDs, or the strip length in the sketch.` });
      }
      return out;
    },
  };
};
