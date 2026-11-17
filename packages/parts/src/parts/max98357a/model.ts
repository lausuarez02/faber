// MAX98357A I2S class-D amplifier. Blocks of samples arrive from the board's I2S bus
// (ctx.model.i2s); the amplifier takes the channel SD selects, measures the block's RMS level,
// applies the gain and drives an RMS voltage across OUT+ / OUT- (bridge-tied load, so the speaker
// part sees the right power). Generic audio output: nothing here knows what the audio is.
// Deterministic: levels come from the samples and virtual time only.
import type { I2sBlock, PartModel, PartModelFactory } from "@fabwright/sim-core";
import { GROUND } from "@fabwright/sim-core";
import { num, round } from "../../lib/props.ts";

/** Full-scale output at 9 dB gain: the datasheet's 3.2 W into 4 Ω at 5 V ≈ 3.6 V RMS; scales with VIN. */
const FS_VRMS_AT_5V = 3.6;
const HOLD_MS = 100;

export const create: PartModelFactory = (ctx): PartModel => {
  let gainDb = num(ctx.props.gain_db, 9);
  let vin = 0;
  let sd = 5;
  let sdFloating = true;
  let gainPinV: number | undefined;
  let level = 0;
  let rate = 0;
  let lastMs = -1e9;
  let blocks = 0;
  let outVrms = 0;

  const mode = (): "off" | "left" | "right" | "mix" => {
    if (vin < 2.5) return "off";
    if (sdFloating) return "left";
    if (sd > 1.4) return "left";
    if (sd > 0.77) return "right";
    if (sd > 0.16) return "mix";
    return "off";
  };

  const effGain = (): number => {
    if (gainPinV === undefined) return gainDb;
    if (gainPinV < 0.3) return 12;
    if (gainPinV > vin - 0.3) return 6;
    return 9;
  };

  const receive = (b: I2sBlock): void => {
    const m = mode();
    if (m === "off") return;
    const full = 2 ** (b.bits - 1);
    const ch = Math.max(1, b.channels);
    let sum = 0;
    let n = 0;
    for (let i = 0; i + ch - 1 < b.samples.length; i += ch) {
      const l = b.samples[i]!;
      const r = ch > 1 ? b.samples[i + 1]! : l;
      const s = m === "left" ? l : m === "right" ? r : (l + r) / 2;
      sum += (s / full) ** 2;
      n++;
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    level = Math.min(1, rms * 10 ** ((effGain() - 9) / 20));
    rate = b.sampleRate;
    blocks++;
    lastMs = ctx.now();
    const v = level * FS_VRMS_AT_5V * (vin / 5);
    if (Math.abs(v - outVrms) > 0.01) {
      outVrms = v;
      ctx.requestSolve();
    }
  };

  return {
    i2s: { i2sReceive: receive },
    stamp(c) {
      c.resistor(ctx.node("VIN"), GROUND, vin > 0 ? vin / (0.0024 + (outVrms * outVrms) / 8 / 0.85 / Math.max(vin, 1)) : 1e6, { id: "supply" });
      c.voltageSource(ctx.node("OUT+"), ctx.node("OUT-"), mode() === "off" ? 0 : outVrms, 0.1, { id: "out" });
      c.resistor(ctx.node("SD"), ctx.node("VIN"), 1_000_000, { id: "sd-pullup" });
      // A sense element on GAIN so an unwired GAIN pin reads as floating (9 dB), not as 0 V (12 dB):
      // a pin with no element at all is not in the solved circuit and reads 0 V (round 13 fix).
      c.resistor(ctx.node("GAIN"), ctx.internalNode("gain-sense"), 1e9, { id: "gain-sense" });
    },
    onSolved(r) {
      vin = r.voltage(ctx.node("VIN")) - r.voltage(ctx.node("GND"));
      sdFloating = r.isFloating(ctx.node("SD")) || ctx.node("SD") === `${ctx.id}:SD`;
      sd = r.voltage(ctx.node("SD"));
      const g = ctx.node("GAIN");
      gainPinV = g === `${ctx.id}:GAIN` || r.isFloating(g) ? undefined : r.voltage(g);
    },
    tick(tMs) {
      if (outVrms > 0 && tMs - lastMs > HOLD_MS) {
        outVrms = 0;
        level = 0;
        ctx.requestSolve();
      }
    },
    visualState() {
      return {
        playing: mode() !== "off" && level > 0.001 && ctx.now() - lastMs <= HOLD_MS,
        level: round(level, 3),
        sampleRate: rate,
        outVrms: round(mode() === "off" ? 0 : outVrms, 3),
        blocks,
      };
    },
    setProp(id, value) {
      if (id === "gain_db") gainDb = num(value, 9);
    },
    diagnostics() {
      if (vin > 0 && vin < 2.5) {
        return [{ severity: "warning", code: "max98357a-undervoltage", pin: "VIN", message: `The amplifier gets ${vin.toFixed(2)} V on VIN, below its 2.5 V minimum, so it stays off. Fix: power VIN from 3.3 V or 5 V.` }];
      }
      return [];
    },
  };
};
