// 1.54 in 200 x 200 black / white e-paper module on the SSD1681 controller (Good Display GDEY0154D67,
// the Waveshare 1.54 in V2 and their clones). The controller is lib/ssd168x.ts; this file adds the
// module: supply, BUSY output, RST, the D/C pin, the power model and what goes wrong.
import { GROUND, type ColorFrame, type Diagnostic, type PartModel, type PartModelFactory, type SpiDevice } from "@jumper/sim-core";
import { SSD1681_200, Ssd168x, type Ssd168xEvent } from "../../lib/ssd168x.ts";

const MIN_VCC = 2.2;
/** Waveshare 1.54 in V2 module: refresh power 26.4 mW (about 8 mA at 3.3 V); standby under 0.01 µA. */
export const REFRESH_MA = 8;
/** Analog supplies on between refreshes (GxEPD2 calls powerOff() to avoid fading): typical, not datasheet. */
const ANALOG_IDLE_MA = 0.5;
/** Controller awake, supplies off (no datasheet figure; typical module measurements). */
const IDLE_UA = 30;
const SLEEP_UA = 1;
const R_BUSY = 200;
const WHITE = 0xffff;
const BLACK = 0x0000;

export const create: PartModelFactory = (ctx): PartModel => {
  const chip = new Ssd168x(SSD1681_200);
  const W = chip.o.width;
  const H = chip.o.height;
  const data = new Uint16Array(W * H).fill(WHITE);
  let shown = -1;
  let vcc = 0;
  let powered = false;
  let busy = false;
  let busyUntil = 0;
  let busyWhat: Ssd168xEvent["what"] = "other";
  let cancel: (() => void) | undefined;
  let rstLow = false;
  let busyViolations = 0;
  let analogSinceMs = -1;
  let maxAnalogMs = 0;
  let energyMas = 0; // mA·s spent refreshing (for the power report)

  const dc = (): 0 | 1 => (ctx.digital ? ctx.digital("DC", Math.max(vcc, 1) * 0.5) : 1);
  const endBusy = () => {
    busy = false;
    cancel = undefined;
    const wasAnalog = chip.analogOn;
    chip.finish();
    if (wasAnalog && !chip.analogOn && analogSinceMs >= 0) {
      maxAnalogMs = Math.max(maxAnalogMs, ctx.now() - analogSinceMs);
      analogSinceMs = -1;
    }
    ctx.requestSolve();
  };
  const startBusy = (e: Ssd168xEvent) => {
    busy = true;
    busyWhat = e.what;
    busyUntil = ctx.now() + e.ms;
    if (chip.analogOn && analogSinceMs < 0) analogSinceMs = ctx.now();
    if (e.what === "full" || e.what === "partial") energyMas += (REFRESH_MA * e.ms) / 1000;
    cancel?.();
    if (ctx.schedule) cancel = ctx.schedule(e.ms, endBusy);
    ctx.requestSolve();
  };

  const spi: SpiDevice = {
    spiTransfer(mosi: number): number {
      if (!powered || rstLow) return 0xff;
      if (busy) busyViolations++;
      const ev = chip.byte(mosi, dc());
      if (ev) startBusy(ev);
      return 0xff;
    },
  };

  const frame = (): ColorFrame => {
    if (shown !== chip.version) {
      for (let i = 0; i < data.length; i++) data[i] = chip.glass[i] ? WHITE : BLACK;
      shown = chip.version;
    }
    return { width: W, height: H, data, version: chip.version, on: true, inverted: false };
  };

  const drawMa = () => {
    if (!powered) return 0;
    if (busy && (busyWhat === "full" || busyWhat === "partial")) return REFRESH_MA;
    if (chip.analogOn) return ANALOG_IDLE_MA;
    return (chip.deepSleep ? SLEEP_UA : IDLE_UA) / 1000;
  };

  return {
    spi,
    stamp(c) {
      const v = ctx.node("VCC");
      const ma = drawMa();
      c.resistor(v, GROUND, Math.max(vcc, 1) / (Math.max(ma, 1e-6) / 1000), { id: "load" });
      if (powered) c.voltageSource(ctx.node("BUSY"), GROUND, busy ? vcc : 0, R_BUSY, { id: "busy" });
      c.resistor(ctx.node("RST"), v, 10_000, { id: "rst-pullup" });
    },
    onSolved(r) {
      const v = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      const now = v >= MIN_VCC;
      const changed = Math.abs(v - vcc) > 0.02 || now !== powered;
      vcc = v;
      if (now !== powered) {
        powered = now;
        if (powered) chip.hardReset();
        else {
          busy = false;
          cancel?.();
          chip.pending = undefined;
        }
      }
      const rst = ctx.digital ? ctx.digital("RST", Math.max(vcc, 1) * 0.5) : r.voltage(ctx.node("RST")) > vcc * 0.5 ? 1 : 0;
      const low = powered && rst === 0;
      if (low && !rstLow) {
        chip.hardReset();
        busy = false;
        cancel?.();
      }
      rstLow = low;
      if (changed) ctx.requestSolve();
    },
    tick(tMs) {
      // without part events (a simple bench), BUSY drops on the tick
      if (!ctx.schedule && busy && tMs >= busyUntil) endBusy();
    },
    framebuffer: frame,
    visualState() {
      const f = frame();
      const black = chip.blackPixels();
      return {
        on: true,
        frame: f.version,
        width: W,
        height: H,
        lit: black,
        blank: black === 0,
        busy,
        refreshing: busy && (busyWhat === "full" || busyWhat === "partial"),
        // generic: the picture is mid-change, a short run should go on until it lands (session run settle_ms)
        settling: busy && (busyWhat === "full" || busyWhat === "partial"),
        refreshes: chip.fullRefreshes + chip.partialRefreshes,
        fullRefreshes: chip.fullRefreshes,
        partialRefreshes: chip.partialRefreshes,
        pending: chip.dirty,
        ghostPixels: chip.ghostPixels,
        sleeping: chip.deepSleep,
        analogOn: chip.analogOn,
        current_ma: Math.round(drawMa() * 1e4) / 1e4,
        refresh_mAs: Math.round(energyMas * 1000) / 1000,
        screenOpacity: 1,
      };
    },
    setProp() {},
    diagnostics(): Diagnostic[] {
      const out: Diagnostic[] = [];
      if (vcc > 3.7) out.push({ severity: "warning", code: "epaper-overvoltage", pin: "VCC", message: `${ctx.id} VCC is ${vcc.toFixed(1)} V. Why: the SSD1681 runs at 2.2 to 3.7 V; only modules with a regulator and level shifter (Waveshare V2) take 5 V. Fix: wire VCC to 3V3 unless your module says 5 V.` });
      if (busyViolations) out.push({ severity: "warning", code: "epaper-busy-ignored", pin: "BUSY", message: `${ctx.id} got ${busyViolations} SPI byte(s) while BUSY was high. Why: the controller is refreshing and ignores or garbles them. Fix: wait for BUSY to go LOW before sending (wire BUSY to an input and pass it to the library, e.g. GxEPD2 / Adafruit_EPD busy pin).` });
      if (chip.ignoredAsleep) out.push({ severity: "info", code: "epaper-asleep", message: `${ctx.id} ignored ${chip.ignoredAsleep} byte(s) because it is in deep sleep (0x10). Why: only a hardware reset wakes the SSD1681. Fix: pulse RST low before drawing again (display.init() / begin() does it; wire RST to a GPIO).` });
      if (chip.unpoweredRefreshes) out.push({ severity: "warning", code: "epaper-unpowered-refresh", message: `${ctx.id} was asked to refresh with its analog supplies off, so the glass did not change. Why: the display update control (0x22) lacked "enable analog" (0x40) and they were not on. Fix: use 0xF7 (full) or 0xFC (partial) as the libraries do, or power on with 0xE0 first.` });
      if (chip.dirty && chip.bytesWritten > 0) out.push({ severity: "info", code: "epaper-not-refreshed", message: `${ctx.id} has new pixels in its RAM that are not on the glass yet. Why: e-paper only changes on a refresh. Fix: call display() / display.display() / update after drawing.` });
      if (chip.ghostPixels > 0) out.push({ severity: "warning", code: "epaper-ghosting", message: `${ctx.id}: the last partial refresh left ${chip.ghostPixels} pixel(s) of the old image. Why: a partial refresh only redraws pixels that differ between the new RAM (0x24) and the previous-image RAM (0x26), and 0x26 did not hold what the glass showed. Fix: write the image to both RAMs after each refresh (GxEPD2 does: writeImageAgain), or do a full refresh now and then.` });
      if (maxAnalogMs > 60_000 || (chip.analogOn && analogSinceMs >= 0 && ctx.now() - analogSinceMs > 60_000)) out.push({ severity: "info", code: "epaper-left-powered", message: `${ctx.id} kept its panel supplies on for over a minute between refreshes. Why: that draws about ${ANALOG_IDLE_MA} mA and lets the image fade. Fix: power the panel off (display.powerOff()) or hibernate (display.hibernate(), command 0x10) after each update.` });
      return out;
    },
    dispose() {
      cancel?.();
    },
  };
};
