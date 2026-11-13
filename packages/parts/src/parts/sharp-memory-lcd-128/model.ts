// Sharp Memory LCD LS013B7DH03 (1.28 in, 128 x 128, 1 bit per pixel with memory in every pixel),
// written from Sharp's datasheet / application note. Each pixel keeps its value with the panel
// powered: no refresh, a few µW for a still image. SPI with an ACTIVE-HIGH chip select (SCS), data
// least significant bit first:
//   command byte: bit 0 M0 = write lines, bit 1 M1 = VCOM level, bit 2 M2 = clear all;
//   write: then per line its address (1..128) and 16 data bytes (bit k of byte i = pixel 8i + k,
//   1 = white), each line followed by a dummy byte; a trailing dummy byte ends the frame.
// The common electrode must be toggled about once a second (M1 or the EXTCOMIN pin), or the
// liquid crystal takes a DC bias and the image degrades over hours. DISP HIGH shows the image.
// A firmware that sends the same bytes MSB first (bit-reversed constants) is understood too.
import { GROUND, type ColorFrame, type Diagnostic, type PartModel, type PartModelFactory, type SpiDevice } from "@jumper/sim-core";

const W = 128;
const H = 128;
const MIN_VCC = 2.7;
/** LS013B7DH03 datasheet (typ, 3 V): static image about 4 µW, writing at 1 Hz about 50 µW. */
const STATIC_UA = 2;
const WRITE_UA = 17;
const VCOM_MAX_MS = 5000;
const WHITE = 0xffff;
const BLACK = 0x0000;

const rev = (b: number) => {
  let r = 0;
  for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i;
  return r;
};

export const create: PartModelFactory = (ctx): PartModel => {
  const mem = new Uint8Array(W * H).fill(1);
  const data = new Uint16Array(W * H).fill(WHITE);
  let version = 0;
  let shownVersion = -1;
  let shownDisp = true;
  let vcc = 0;
  let powered = false;
  let disp = true;
  // frame decoder
  let state: "cmd" | "addr" | "data" | "dummy" | "clear-dummy" | "idle" = "cmd";
  let reversed = false;
  let line = 0;
  let col = 0;
  let lastVcom = -1;
  let lastVcomMs = -1;
  let maxVcomGapMs = 0;
  let vcomToggles = 0;
  let linesWritten = 0;
  let clears = 0;
  let badLines = 0;
  let lastWriteMs = -Infinity;

  const vcomEdge = (level: number) => {
    if (lastVcom >= 0 && level !== lastVcom) {
      const t = ctx.now();
      if (lastVcomMs >= 0) maxVcomGapMs = Math.max(maxVcomGapMs, t - lastVcomMs);
      lastVcomMs = t;
      vcomToggles++;
    }
    if (lastVcom < 0) lastVcomMs = ctx.now();
    lastVcom = level;
  };

  const spi: SpiDevice = {
    spiSelect(sel) {
      if (sel) state = "cmd";
    },
    spiTransfer(raw: number): number {
      if (!powered) return 0;
      if (state === "cmd") {
        reversed = (raw & 0x07) === 0 && (raw & 0xe0) !== 0;
        const b = reversed ? rev(raw) : raw;
        vcomEdge((b >> 1) & 1);
        if (b & 0x04) {
          mem.fill(1);
          version++;
          clears++;
          state = "clear-dummy";
        } else if (b & 0x01) state = "addr";
        else state = "idle"; // VCOM-only frame (the "toggle" command)
        return 0;
      }
      const b = reversed ? rev(raw) : raw;
      if (state === "addr") {
        if (b === 0) {
          state = "idle"; // the trailing dummy: frame done
          return 0;
        }
        if (b > H) {
          badLines++;
          state = "idle";
          return 0;
        }
        line = b - 1;
        col = 0;
        state = "data";
        return 0;
      }
      if (state === "data") {
        for (let k = 0; k < 8; k++) mem[line * W + col * 8 + k] = (b >> k) & 1;
        if (++col === W / 8) {
          state = "dummy";
          linesWritten++;
          version++;
          lastWriteMs = ctx.now();
        }
        return 0;
      }
      if (state === "dummy") {
        state = "addr";
        return 0;
      }
      if (state === "clear-dummy") state = "idle";
      return 0;
    },
  };

  const frame = (): ColorFrame => {
    if (shownVersion !== version || shownDisp !== (disp && powered)) {
      const on = disp && powered;
      for (let i = 0; i < mem.length; i++) data[i] = on ? (mem[i] ? WHITE : BLACK) : WHITE;
      shownVersion = version;
      shownDisp = on;
    }
    return { width: W, height: H, data, version: version * 2 + (disp && powered ? 1 : 0), on: true, inverted: false };
  };

  return {
    spi,
    stamp(c) {
      const writing = ctx.now() - lastWriteMs < 1000;
      const ua = powered ? (writing ? WRITE_UA : STATIC_UA) : 0;
      c.resistor(ctx.node("VIN"), GROUND, Math.max(vcc, 1) / (Math.max(ua, 0.001) / 1e6), { id: "load" });
    },
    onSolved(r) {
      const v = r.voltage(ctx.node("VIN")) - r.voltage(ctx.node("GND"));
      const now = v >= MIN_VCC;
      if (now !== powered) {
        powered = now;
        if (!powered) mem.fill(1); // memory-in-pixel needs power: the image is lost
        version++;
      }
      vcc = v;
      const d = ctx.digital ? ctx.digital("DISP", Math.max(vcc, 1) * 0.5) : r.voltage(ctx.node("DISP")) > vcc * 0.5 ? 1 : 0;
      disp = d === 1;
      const ext = ctx.digital ? ctx.digital("EXTCOMIN", Math.max(vcc, 1) * 0.5) : 0;
      if (ext !== lastVcom && lastVcom >= 0) vcomEdge(ext);
    },
    framebuffer: frame,
    visualState() {
      let black = 0;
      if (disp && powered) for (const v of mem) if (!v) black++;
      return { on: disp && powered, frame: frame().version, width: W, height: H, lit: black, blank: black === 0, disp, linesWritten, clears, vcomToggles, current_ua: powered ? (ctx.now() - lastWriteMs < 1000 ? WRITE_UA : STATIC_UA) : 0, screenOpacity: 1 };
    },
    setProp() {},
    diagnostics(): Diagnostic[] {
      const out: Diagnostic[] = [];
      if (vcc > 5.5) out.push({ severity: "error", code: "memlcd-overvoltage", pin: "VIN", message: `${ctx.id} VIN is ${vcc.toFixed(1)} V. Why: the panel takes 3 V (breakouts with a regulator up to 5 V). Fix: wire VIN to 3V3.` });
      if (powered && !disp && linesWritten) out.push({ severity: "info", code: "memlcd-disp-low", pin: "DISP", message: `${ctx.id} has an image but DISP is LOW, so the glass shows nothing. Fix: drive DISP HIGH (or tie it to 3V3).` });
      const gap = Math.max(maxVcomGapMs, lastVcomMs >= 0 ? ctx.now() - lastVcomMs : linesWritten ? ctx.now() : 0);
      if (linesWritten && gap > VCOM_MAX_MS) out.push({ severity: "warning", code: "memlcd-vcom", message: `${ctx.id}'s common electrode (VCOM) was not toggled for ${(gap / 1000).toFixed(1)} s. Why: the panel needs VCOM inverted about once a second (the M1 bit, or a square wave on EXTCOMIN), or the liquid crystal takes a DC bias and the image degrades. Fix: call refresh() / toggleVcom() every second (Adafruit_SharpMem does on refresh), or feed EXTCOMIN from a 1 Hz timer that also runs while the MCU sleeps.` });
      if (badLines) out.push({ severity: "warning", code: "memlcd-bad-line", message: `${ctx.id} got ${badLines} line address(es) over 128. Why: lines are numbered 1..128, sent LSB first. Fix: send line + 1 for row 0..127, with SPI in LSBFIRST mode.` });
      return out;
    },
  };
};
