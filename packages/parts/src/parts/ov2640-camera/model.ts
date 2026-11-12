// OV2640 camera module (round 13): a general camera part. esp32-camera's init finds it on the GPIOs
// its pins are wired to; frames come from what it is set to see (lib/cameraPart.ts).
import type { PartModel, PartModelFactory } from "@jumper/sim-core";
import { GROUND } from "@jumper/sim-core";
import { createCameraPart } from "../../lib/cameraPart.ts";

const ACTIVE_A = 0.04;

export const create: PartModelFactory = (ctx): PartModel => {
  let vdd = 0;
  const powered = () => vdd >= 3.0 && vdd <= 3.6;
  const camera = createCameraPart(ctx, { sensor: "OV2640", powered });
  return {
    camera: camera.device,
    stamp(c) {
      c.resistor(ctx.node("3V3"), GROUND, 3.3 / ACTIVE_A, { id: "supply" });
    },
    onSolved(r) {
      vdd = r.voltage(ctx.node("3V3")) - r.voltage(ctx.node("GND"));
    },
    visualState() {
      return { ...camera.visual(), powered: powered() };
    },
    setProp(id, value) {
      camera.setProp(id, value);
    },
    diagnostics() {
      const d: ReturnType<NonNullable<PartModel["diagnostics"]>> = [];
      if (vdd > 3.6) d.push({ severity: "error", code: "ov2640-overvoltage", pin: "3V3", message: `The camera gets ${vdd.toFixed(2)} V on 3V3; its maximum is 3.6 V and 5 V damages it. Fix: power it from the board's 3.3 V pin.` });
      else if (vdd > 0.5 && vdd < 3.0) d.push({ severity: "warning", code: "ov2640-undervoltage", pin: "3V3", message: `The camera gets ${vdd.toFixed(2)} V, below 3.0 V, so it does not answer esp_camera_init. Fix: power 3V3 from the board's 3.3 V pin.` });
      const p = camera.problem();
      if (p) d.push({ severity: "warning", code: "camera-image", message: p });
      return d;
    },
  };
};
