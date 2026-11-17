// ILI9341 2.8in 240x320 colour TFT on SPI. The controller is MipiPanel (lib/mipiPanel.ts); this
// file adds the module: supply and backlight, the D/C and RESET pins, the 10 kΩ pull-ups on RESET
// and LED, and the 3.3 V logic check for bare modules.
import { colorFrameStats, type ColorFrame, type Diagnostic, type PartContext, type PartModel, type PartModelFactory, type SpiDevice } from "@faber/sim-core";
import { MipiPanel, type PanelOptions } from "../../lib/mipiPanel.ts";
import { round, str } from "../../lib/props.ts";

export const ILI9341_PANEL: PanelOptions = {
  nativeW: 240,
  nativeH: 320,
  viewer: "landscape",
  bgrPanel: true,
  id4: [0x00, 0x93, 0x41],
};

/** Supply below this: the module's regulator and the controller are off. */
const MIN_VCC = 2.6;
const LOGIC_MA = 20;
const BACKLIGHT_MA = 60;

export interface TftModuleOptions {
  panel: PanelOptions;
  /** Name in messages, e.g. "ILI9341". */
  chip: string;
  logicMa?: number;
  backlightMa?: number;
}

/** Shared by ili9341-tft and st7735-tft: the module around a MipiPanel controller. */
export function createTftModule(ctx: PartContext, o: TftModuleOptions): PartModel & { panel: MipiPanel } {
  const panel = new MipiPanel(o.panel);
  let logic = str(ctx.props.logic, "5v-safe");
  let vcc = 0;
  let powered = false;
  let resetLow = false;
  let backlight = 0;
  let maxLogicV = 0;
  let lastStatsVersion = -1;
  let stats = { lit: 0, bright: 0 };
  let ledId = "";
  const logicPins = ["CS", "DC", "RST", "MOSI", "SCK"].filter((p) => ctx.spec.pins.some((sp) => sp.id === p));

  const dc = (): 0 | 1 => (ctx.digital ? ctx.digital("DC", vcc * 0.5) : 1);

  const spi: SpiDevice = {
    spiTransfer(mosi: number): number {
      if (!powered || resetLow) return 0xff;
      return panel.byte(mosi, dc());
    },
  };

  const frameOn = () => powered && backlight > 0.02;

  const model: PartModel & { panel: MipiPanel } = {
    panel,
    spi,
    stamp(c) {
      const v = ctx.node("VCC");
      // Logic + regulator, and the backlight LEDs at the brightness of the last solve.
      c.resistor(v, "0", 5 / ((o.logicMa ?? LOGIC_MA) / 1000), { id: "logic" });
      if (backlight > 0.01) c.resistor(v, "0", 5 / (((o.backlightMa ?? BACKLIGHT_MA) * backlight) / 1000), { id: "backlight" });
      c.resistor(ctx.node("RST"), v, 10_000, { id: "rst-pullup" });
      ledId = c.resistor(ctx.node("LED"), v, 10_000, { id: "led-pullup" });
    },
    onSolved(r) {
      vcc = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      const nowPowered = vcc >= MIN_VCC;
      if (powered && !nowPowered) panel.powerOff();
      powered = nowPowered;
      const rst = ctx.digital ? ctx.digital("RST", vcc * 0.5) : r.voltage(ctx.node("RST")) > vcc * 0.5 ? 1 : 0;
      const low = powered && rst === 0;
      if (low && !resetLow) panel.reset();
      resetLow = low;
      const pwm = ctx.pwm?.("LED");
      let bl: number;
      if (pwm && pwm.averaged) bl = pwm.duty;
      else bl = r.voltage(ctx.node("LED")) > Math.max(1.2, vcc * 0.4) ? 1 : 0;
      if (!powered) bl = 0;
      if (Math.abs(bl - backlight) > 0.004) {
        backlight = bl;
        panel.version++;
      }
      void ledId;
      if (logic === "3v3-only") for (const p of logicPins) maxLogicV = Math.max(maxLogicV, r.voltage(ctx.node(p)));
    },
    framebuffer(): ColorFrame {
      return panel.framebuffer(frameOn());
    },
    visualState() {
      const f = panel.framebuffer(frameOn());
      if (f.version !== lastStatsVersion) {
        stats = colorFrameStats(f);
        lastStatsVersion = f.version;
      }
      const on = f.on;
      return {
        on,
        backlight: round(backlight),
        frame: panel.version,
        width: panel.width,
        height: panel.height,
        rotation: panel.rotation,
        lit: stats.lit,
        bright: stats.bright,
        blank: stats.lit === 0,
        sleeping: panel.regs.sleeping,
        inverted: panel.regs.inverted,
        pixelsWritten: panel.pixelsWritten,
        screenOpacity: on ? 1 : 0,
      };
    },
    setProp(id, value) {
      if (id === "logic") {
        logic = str(value, "5v-safe");
        maxLogicV = 0;
      }
    },
    diagnostics(): Diagnostic[] {
      const out: Diagnostic[] = [];
      if (vcc > 5.6) {
        out.push({ severity: "error", code: "tft-overvoltage", pin: "VCC", message: `${o.chip} module VCC is ${vcc.toFixed(1)} V, above its 5.5 V maximum: the regulator will overheat. Power it from the board's 5V or 3V3 pin.` });
      } else if (!powered && vcc > 0.5) {
        out.push({ severity: "warning", code: "tft-undervoltage", pin: "VCC", message: `${o.chip} module VCC is only ${vcc.toFixed(1)} V, so the display stays dark (needs 3.0 to 5.5 V). Wire VCC to 5V or 3V3.` });
      }
      if (logic === "3v3-only" && maxLogicV > 3.6) {
        out.push({
          severity: "error",
          code: "tft-logic-5v",
          message: `${o.chip} logic pins see ${maxLogicV.toFixed(1)} V but this module is 3.3 V logic (max 3.6 V): it works for a while on real hardware, then glitches or dies. Put a 74HC4050 level shifter (or 10 kΩ series resistors) between the Uno and CS, DC, RESET, MOSI and SCK, or use a 5 V-safe breakout (prop logic = 5v-safe).`,
        });
      }
      if (powered && panel.commands > 0 && panel.regs.sleeping && panel.pixelsWritten > 0) {
        out.push({ severity: "info", code: "tft-sleeping", message: `${o.chip} received pixels but is still in sleep mode, so the glass is dark. Send SLPOUT (0x11) and DISPON (0x29), which tft.begin() does; check that begin() runs before drawing.` });
      }
      if (powered && backlight < 0.02 && panel.lit) {
        out.push({ severity: "info", code: "tft-backlight-off", pin: "LED", message: `${o.chip} is drawing but its backlight is off, so the screen looks black. Wire LED to 5V (or a PWM pin set HIGH / analogWrite).` });
      }
      return out;
    },
  };
  return model;
}

export const create: PartModelFactory = (ctx) => createTftModule(ctx, { panel: ILI9341_PANEL, chip: "ILI9341" });
