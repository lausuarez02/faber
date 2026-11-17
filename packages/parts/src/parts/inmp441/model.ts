// INMP441 I2S MEMS microphone. When the board's I2S peripheral asks for samples (I2sDevice
// i2sProvide), it returns what the mic "hears": silence, a sine tone, deterministic noise or a PCM
// clip, at the set sound pressure with the datasheet sensitivity (94 dB SPL = -26 dBFS), as 24-bit
// data left-justified in the slot width the firmware asked for. Generic audio input.
// Deterministic: a fixed-seed generator and frame counters, no wall clock or Math.random.
import type { I2sRequest, PartModel, PartModelFactory } from "@fabwright/sim-core";
import { base64ToBytes, GROUND } from "@fabwright/sim-core";
import { num, round, str } from "../../lib/props.ts";

const HOLD_MS = 100;

export const create: PartModelFactory = (ctx): PartModel => {
  let sound = str(ctx.props.sound, "silence");
  let spl = num(ctx.props.spl_db, 70);
  let toneHz = num(ctx.props.tone_hz, 1000);
  let clip = decodeClip(str(ctx.props.clip_b64, ""));
  let vdd = 0;
  let right = false;
  let frame = 0;
  let seed = 0x12345678;
  let lastMs = -1e9;
  let reads = 0;

  /** Amplitude 0..1 of full scale: -26 dBFS at 94 dB SPL, RMS for a sine → peak × √2. */
  const amp = () => Math.min(1, 10 ** ((spl - 94 - 26) / 20) * Math.SQRT2);
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 31 - 1;
  };

  const sample = (rate: number): number => {
    switch (sound) {
      case "tone":
        return amp() * Math.sin((2 * Math.PI * toneHz * frame) / rate);
      case "noise":
        return (amp() / Math.SQRT2) * Math.sqrt(3) * noise();
      case "clip": {
        if (clip.length === 0) return 0;
        const i = Math.floor((frame * 16000) / rate) % clip.length;
        return (clip[i]! / 32768) * Math.min(1, amp() / 0.5);
      }
      default:
        return 0;
    }
  };

  const provide = (req: I2sRequest): Int32Array | undefined => {
    if (vdd < 1.8) return undefined;
    reads++;
    lastMs = ctx.now();
    const ch = Math.max(1, req.channels);
    const out = new Int32Array(req.frames * ch);
    const full = 2 ** (req.bits - 1) - 1;
    // 24-bit converter: the low bits of a 32-bit slot are zero.
    const quant = req.bits > 24 ? 2 ** (req.bits - 24) : 1;
    const slot = ch === 1 ? 0 : right ? 1 : 0;
    for (let f = 0; f < req.frames; f++) {
      const v = Math.round((sample(req.sampleRate) * full) / quant) * quant;
      out[f * ch + slot] = v;
      frame++;
    }
    return out;
  };

  return {
    i2s: { i2sProvide: provide },
    stamp(c) {
      c.resistor(ctx.node("VDD"), GROUND, 3.3 / 0.0014, { id: "supply" });
    },
    onSolved(r) {
      vdd = r.voltage(ctx.node("VDD")) - r.voltage(ctx.node("GND"));
      right = r.voltage(ctx.node("L/R")) > vdd / 2 && !r.isFloating(ctx.node("L/R"));
    },
    visualState() {
      const level = sound === "silence" ? -120 : 20 * Math.log10(amp() / Math.SQRT2);
      return { listening: vdd >= 1.8 && ctx.now() - lastMs <= HOLD_MS, levelDbfs: round(level, 1), reads };
    },
    setProp(id, value) {
      if (id === "sound") sound = str(value, "silence");
      if (id === "spl_db") spl = num(value, 70);
      if (id === "tone_hz") toneHz = num(value, 1000);
      if (id === "clip_b64") clip = decodeClip(str(value, ""));
    },
    diagnostics() {
      if (vdd > 3.6) return [{ severity: "error", code: "inmp441-overvoltage", pin: "VDD", message: `The microphone gets ${vdd.toFixed(2)} V on VDD; its maximum is 3.6 V and 5 V damages it. Fix: power VDD from the board's 3.3 V pin.` }];
      if (vdd > 0 && vdd < 1.8) return [{ severity: "warning", code: "inmp441-undervoltage", pin: "VDD", message: `The microphone gets ${vdd.toFixed(2)} V, below 1.8 V, so it sends no data (the board reads silence). Fix: power VDD from 3.3 V.` }];
      return [];
    },
  };
};

function decodeClip(b64: string): Int16Array {
  if (!b64) return new Int16Array(0);
  const bytes = base64ToBytes(b64);
  const out = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = (bytes[2 * i]! | (bytes[2 * i + 1]! << 8)) << 16 >> 16;
  return out;
}
