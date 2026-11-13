// TI DRV5032 ultra-low-power Hall-effect switch (datasheet SLVSDC7H). Omnipolar: OUT is LOW while
// |B| >= B_OP and goes back HIGH (push-pull) / released (open-drain) once |B| < B_RP. The chip only
// looks at the field at its sampling instants (5 Hz FB, 20 Hz others), which is the output latency.
import { GROUND, type Diagnostic, type PartModel, type PartModelFactory } from "@jumper/sim-core";
import { MAGNET_GRADES, distanceForField, magnetInteraction, magnetOf } from "../../lib/magnet.ts";
import { round, str } from "../../lib/props.ts";

/** Typical values at 3 V (tables 4-1, 6.5, 6.6). */
export const DRV5032: Record<string, { bop: number; brp: number; hz: number; ua: number; openDrain: boolean }> = {
  FA: { bop: 3, brp: 1.5, hz: 20, ua: 1.6, openDrain: false },
  FB: { bop: 3, brp: 1.5, hz: 5, ua: 0.69, openDrain: false },
  FC: { bop: 3, brp: 1.5, hz: 20, ua: 1.6, openDrain: true },
  AJ: { bop: 7, brp: 5.6, hz: 20, ua: 1.6, openDrain: true },
};
const MIN_VCC = 1.65;
const R_OUT = 100; // VOH = VCC - 0.1 V at 1 mA

export const create: PartModelFactory = (ctx): PartModel => {
  const props: Record<string, unknown> = { ...ctx.props };
  const ver = () => DRV5032[str(props.version as never, "FB")] ?? DRV5032.FB!;
  let detected = false;
  let detections = 0;
  let vcc = 0;
  let powered = false;
  let cancel: (() => void) | undefined;
  let lastSampleMs = -Infinity;

  const sample = () => {
    const v = ver();
    const b = magnetOf(props as never).mT;
    const was = detected;
    detected = detected ? b >= v.brp : b >= v.bop;
    if (detected && !was) detections++;
    lastSampleMs = ctx.now();
    if (detected !== was) ctx.requestSolve();
  };
  const arm = () => {
    cancel?.();
    cancel = undefined;
    if (!powered) return;
    const period = 1000 / ver().hz;
    if (ctx.schedule) {
      const loop = () => {
        sample();
        cancel = ctx.schedule!(period, loop);
      };
      cancel = ctx.schedule(period, loop);
    }
  };

  return {
    stamp(c) {
      const v = ver();
      c.resistor(ctx.node("VCC"), GROUND, Math.max(vcc, 1) / (v.ua / 1e6), { id: "chip" });
      if (!powered) return;
      if (v.openDrain) {
        if (detected) c.resistor(ctx.node("OUT"), GROUND, R_OUT, { id: "od" });
      } else c.voltageSource(ctx.node("OUT"), GROUND, detected ? 0 : vcc, R_OUT, { id: "out" });
    },
    onSolved(r) {
      const v = r.voltage(ctx.node("VCC")) - r.voltage(ctx.node("GND"));
      const now = v >= MIN_VCC;
      const changed = Math.abs(v - vcc) > 0.02 || now !== powered;
      vcc = v;
      if (now !== powered) {
        powered = now;
        detected = false;
        if (powered) sample(); // first sample right after power-on (t_ON 55 µs)
        arm();
      }
      if (changed) ctx.requestSolve();
    },
    tick(tMs) {
      // without part events (a simple bench), sample on the tick at the sampling rate
      if (ctx.schedule || !powered) return;
      if (tMs - lastSampleMs >= 1000 / ver().hz) sample();
    },
    visualState() {
      const m = magnetOf(props as never);
      const v = ver();
      return { detected, out: powered && !detected && !v.openDrain, field_mT: round(m.mT, 2), magnet_mm: m.distance, detects_at_mm: round(distanceForField(v.bop, m.d, m.t, MAGNET_GRADES[m.grade] ?? 1.19), 1), sample_ms: 1000 / v.hz, detections, dotOpacity: detected ? 1 : 0 };
    },
    setProp(id, value) {
      props[id] = value;
      if (id === "version") arm();
    },
    interact(e) {
      const mm = magnetInteraction(e, 2, 40);
      if (mm !== undefined) props.magnet_mm = mm;
    },
    diagnostics(): Diagnostic[] {
      const out: Diagnostic[] = [];
      if (vcc > 5.6) out.push({ severity: "error", code: "drv5032-overvoltage", pin: "VCC", message: `${ctx.id} VCC is ${vcc.toFixed(1)} V, above the DRV5032's 5.5 V maximum. Why: it is wired to a higher rail. Fix: wire VCC to 3V3.` });
      else if (!powered && vcc > 0.3) out.push({ severity: "warning", code: "drv5032-undervoltage", pin: "VCC", message: `${ctx.id} VCC is ${vcc.toFixed(2)} V, under its 1.65 V minimum, so OUT never changes. Fix: wire VCC to 3V3 and GND to GND.` });
      return out;
    },
    dispose() {
      cancel?.();
    },
  };
};
