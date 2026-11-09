// HC-SR501 PIR module (BISS0001). OUT: 3.3 V push-pull. Motion is an input the person or a
// scenario sets. Repeat mode (H): OUT stays HIGH until delay_s after the last motion; single mode
// (L): one delay_s pulse. After OUT falls, motion is ignored for the 2.5 s block time.
import type { Diagnostic, PartModel, PartModelFactory } from "@jumper/sim-core";
import { GROUND } from "@jumper/sim-core";
import { clamp, num, str, truthy } from "../../lib/props.ts";

export const BLOCK_MS = 2500;
const MIN_VCC = 4.5;
const OUT_V = 3.3;

export const create: PartModelFactory = (ctx): PartModel => {
  let delayMs = clamp(num(ctx.props.delay_s, 5), 0.5, 600) * 1000;
  let repeat = str(ctx.props.retrigger, "repeat") !== "single";
  let warmupMs = clamp(num(ctx.props.warmup_s, 0), 0, 120) * 1000;
  let motion = false;
  let out = false;
  let triggers = 0;
  let vcc = 0;
  let powered = false;
  let poweredAt = 0;
  let blockedUntil = -1;
  let lastMotionAt = -Infinity;
  let pending: (() => void) | undefined;
  let missed = 0;

  const now = () => ctx.now();
  const warming = () => powered && now() < poweredAt + warmupMs;
  const blocked = () => now() < blockedUntil;

  const at = (ms: number, cb: () => void) => {
    pending?.();
    pending = ctx.schedule ? ctx.schedule(Math.max(0, ms - now()), () => ((pending = undefined), cb())) : undefined;
  };

  /** Re-evaluate after any change: motion, power, end of warm-up / hold / block. */
  const evaluate = () => {
    if (!powered) {
      if (out) out = false;
      return;
    }
    if (!ctx.schedule) {
      // No clock (simple bench): OUT simply follows motion.
      if (motion && !out) triggers++;
      out = motion;
      return;
    }
    if (warming()) {
      if (motion) missed++;
      at(poweredAt + warmupMs, evaluate);
      return;
    }
    if (out) return; // the hold timer ends it
    if (blocked()) {
      at(blockedUntil, evaluate);
      return;
    }
    if (motion) {
      out = true;
      triggers++;
      at(now() + delayMs, hold);
      ctx.requestSolve();
    }
  };

  /** Hold time is over: in repeat mode keep going while motion continues. */
  const hold = () => {
    if (repeat && (motion || now() < lastMotionAt + delayMs)) {
      at(Math.max(now() + 1, lastMotionAt + delayMs, motion ? now() + delayMs : 0), hold);
      return;
    }
    out = false;
    blockedUntil = now() + BLOCK_MS;
    ctx.requestSolve();
    at(blockedUntil, evaluate);
  };

  const setMotion = (m: boolean) => {
    if (m) lastMotionAt = now();
    if (motion && !m) lastMotionAt = now();
    motion = m;
    evaluate();
  };

  return {
    stamp(c) {
      c.resistor(ctx.node("VCC"), GROUND, 5 / 0.000065, { id: "supply" });
      if (powered) c.voltageSource(ctx.node("OUT"), GROUND, out ? OUT_V : 0, 100, { id: "out" });
    },
    onSolved(r) {
      vcc = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      const p = vcc >= MIN_VCC;
      if (p !== powered) {
        powered = p;
        poweredAt = now();
        if (!p) {
          pending?.();
          pending = undefined;
          out = false;
          blockedUntil = -1;
        }
        evaluate();
        ctx.requestSolve();
      }
    },
    visualState() {
      const state = !powered ? "off" : warming() ? "warming up" : out ? "motion" : blocked() ? "blocked" : "idle";
      return { motion, out: powered && out, triggers, state, glowOpacity: powered && out ? 1 : 0 };
    },
    setProp(id, v) {
      if (id === "delay_s") delayMs = clamp(num(v, delayMs / 1000), 0.5, 600) * 1000;
      if (id === "retrigger") repeat = str(v, "repeat") !== "single";
      if (id === "warmup_s") warmupMs = clamp(num(v, warmupMs / 1000), 0, 120) * 1000;
    },
    interact(e) {
      if (e.kind === "press") setMotion(true);
      else if (e.kind === "release") setMotion(false);
      else if (e.kind === "set" && (e.key === undefined || e.key === "motion")) setMotion(truthy(e.value));
    },
    diagnostics() {
      const out: Diagnostic[] = [];
      const id = ctx.id;
      if (!powered && vcc > 0.3) {
        out.push({
          severity: "error",
          code: "pir-undervoltage",
          pin: "VCC",
          message: `${id} VCC is ${vcc.toFixed(1)} V; the HC-SR501 needs 4.5 to 20 V (its regulator makes 3.3 V from it), so OUT never goes HIGH. Wire VCC to 5V (VBUS / VSYS on a 3.3 V board). OUT is 3.3 V and safe for any board.`,
        });
      }
      if (missed > 0) {
        out.push({ severity: "info", code: "pir-warming-up", message: `${id} ignored motion ${missed} time(s) during its ${warmupMs / 1000} s warm-up after power-up. Wait (real modules need 30–60 s) before relying on it.` });
      }
      if (vcc > 20.5) out.push({ severity: "error", code: "pir-overvoltage", pin: "VCC", message: `${id} VCC is ${vcc.toFixed(1)} V, above 20 V. Use 5 V.` });
      return out;
    },
    dispose() {
      pending?.();
      pending = undefined;
    },
  };
};
