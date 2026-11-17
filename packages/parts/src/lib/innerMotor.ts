// Reuses the dc-motor model (back-EMF, winding resistance, friction, inertia, duty-averaged PWM;
// proven in parts/dc-motor/model.test.ts) inside another part: a water pump's or a vibration
// motor's brushed motor. The inner model sees a context whose "A" / "B" pins map to the outer
// part's own pins or internal nodes, and whose props are the motor constants the outer part picks.
import type { PropValue } from "@faber/project-format";
import type { PartContext, PartModel } from "@faber/sim-core";
import { create as createDcMotor } from "../parts/dc-motor/model.ts";

export interface InnerMotorParams {
  ratedVoltage: number;
  noLoadRpm: number;
  stallCurrent: number;
  noLoadCurrent: number;
  timeConstantMs: number;
}

export interface InnerMotor {
  model: PartModel;
  /** Change the constants (the outer part's setProp). */
  update(p: InnerMotorParams): void;
  rpm(): number;
  /** Winding current in A (positive A → B). */
  currentA(): number;
  /** Voltage across the winding A − B. */
  volts(): number;
}

/**
 * `a` / `b`: the node of the motor's + and − terminals (an outer pin's ctx.node or an internalNode).
 * `pwmPin`: outer pin whose PWM reading switches this winding (an MCU pin driving it directly or a
 * transistor's base), so the inner model averages over the duty cycle.
 */
export function innerMotor(ctx: PartContext, nodes: { a: string; b: string }, params: InnerMotorParams, pwmPins: { a?: string; b?: string } = {}): InnerMotor {
  const props: Record<string, PropValue> = { ...params };
  const inner: PartContext = {
    id: ctx.id,
    spec: ctx.spec,
    props,
    node: (pin) => (pin === "A" ? nodes.a : nodes.b),
    internalNode: (name) => ctx.internalNode(`motor-${name}`),
    requestSolve: () => ctx.requestSolve(),
    now: () => ctx.now(),
    ...(ctx.pwm
      ? {
          pwm: (pin: string) => {
            const outer = pin === "A" ? pwmPins.a : pwmPins.b;
            return outer ? ctx.pwm!(outer) : undefined;
          },
        }
      : {}),
  };
  const model = createDcMotor(inner);
  const num = (k: string) => {
    const v = model.visualState()[k];
    return typeof v === "number" ? v : 0;
  };
  return {
    model,
    update(p) {
      Object.assign(props, p);
      model.setProp("ratedVoltage", p.ratedVoltage);
    },
    rpm: () => num("rpm"),
    currentA: () => num("currentmA") / 1000,
    volts: () => num("volts"),
  };
}
