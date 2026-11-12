// Seeed XIAO ESP32-S3 Sense (round 13): the XIAO ESP32-S3 board model plus what the Sense board
// carries: the camera (a general camera part on the board's own GPIOs, frames from Jumper) and the
// PDM microphone (samples on the board's I2S bus, generic audio input).
import type { I2sRequest, PartModel, PartModelFactory, VisualState } from "@jumper/sim-core";
import { base64ToBytes } from "@jumper/sim-core";
import { createCameraPart } from "../../lib/cameraPart.ts";
import { createEspBoardModel, limit } from "../../lib/espBoard.ts";
import { round, str } from "../../lib/props.ts";
import { CHARGE_A, TRICKLE_A } from "../seeed-xiao-esp32s3/model.ts";

export const create: PartModelFactory = (ctx): PartModel => {
  const board = createEspBoardModel(ctx, {
    supply: {
      usbPin: "5V",
      diodes: [
        { id: "vbus-path", from: "5V", to: "@sys", vf: 0.3, rOn: 0.05 },
        { id: "bat-path", from: "BAT", to: "@sys", vf: 0.05, rOn: 0.1 },
      ],
      regulators: [{ id: "ldo", from: "@sys", to: "3V3", params: { volts: 3.3, dropout: limit(ctx, "ldoDropoutV", 0.25), rOut: 0.01, iq: 0.00005, minIn: 1 } }],
      logicPin: "3V3",
      minLogicV: limit(ctx, "min3v3V", 3.0),
      selfmA: 22,
    },
    leds: [{ key: "led_user", pin: "GPIO21", activeLow: true }],
    charger: { input: "5V", bat: "BAT", chargeA: CHARGE_A, trickleA: TRICKLE_A },
  });
  const powered = () => board.powered?.() ?? true;
  const sensor = (ctx.spec.camera?.sensor ?? "OV2640") as "OV2640";
  const camera = createCameraPart(ctx, { sensor, powered });

  // PDM microphone (MSM261D3526H1CPM class): the S3's I2S peripheral turns its PDM stream into PCM,
  // so it reaches the firmware as samples on the I2S bus.
  let sound = str(ctx.props.mic_sound, "silence");
  let clip = decodeClip(str(ctx.props.mic_clip_b64, ""));
  let frame = 0;
  let seed = 0x2468ace1;
  const amp = 10 ** ((70 - 94 - 26) / 20) * Math.SQRT2; // 70 dB SPL, -26 dBFS at 94 dB SPL
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 31 - 1;
  };
  const sample = (rate: number) => {
    if (sound === "tone") return amp * Math.sin((2 * Math.PI * 1000 * frame) / rate);
    if (sound === "noise") return (amp / Math.SQRT2) * Math.sqrt(3) * noise();
    if (sound === "clip" && clip.length) return clip[Math.floor((frame * 16000) / rate) % clip.length]! / 32768;
    return 0;
  };
  const provide = (req: I2sRequest): Int32Array | undefined => {
    if (!powered()) return undefined;
    const ch = Math.max(1, req.channels);
    const out = new Int32Array(req.frames * ch);
    const full = 2 ** (req.bits - 1) - 1;
    for (let f = 0; f < req.frames; f++) {
      const v = Math.round(sample(req.sampleRate) * full);
      for (let c = 0; c < ch; c++) out[f * ch + c] = v;
      frame++;
    }
    return out;
  };

  return {
    ...board,
    camera: camera.device,
    i2s: { i2sProvide: provide },
    visualState(): VisualState {
      const v = camera.visual();
      const level = sound === "silence" ? -120 : sound === "clip" ? -6 : 20 * Math.log10(amp / Math.SQRT2);
      return {
        ...board.visualState(),
        ...v,
        camera_label: `${sensor}${v.camera_size ? ` · ${v.camera_size}` : " camera"}`,
        mic_level_dbfs: round(level, 1),
      };
    },
    setProp(id, value) {
      if (camera.setProp(id, value)) return;
      if (id === "mic_sound") sound = str(value, "silence");
      else if (id === "mic_clip_b64") clip = decodeClip(str(value, ""));
      else board.setProp(id, value);
    },
    diagnostics() {
      const d = [...(board.diagnostics?.() ?? [])];
      const p = camera.problem();
      if (p) d.push({ severity: "warning", code: "camera-image", message: p });
      return d;
    },
  };
};

function decodeClip(b64: string): Int16Array {
  if (!b64) return new Int16Array(0);
  const bytes = base64ToBytes(b64);
  const out = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = ((bytes[2 * i]! | (bytes[2 * i + 1]! << 8)) << 16) >> 16;
  return out;
}
