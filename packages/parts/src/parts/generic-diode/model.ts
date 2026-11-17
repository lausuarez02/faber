import type { PartModelFactory } from "@faber/sim-core";
import { createDiodeModel } from "../../lib/diode.ts";

/** 1N4148 signal diode, piecewise linear: 0.6 V knee + 4 Ω → about 0.64 V at 10 mA, 1.0 V at 100 mA. */
export const SIGNAL_DIODE = { vf: 0.6, rOn: 4 } as const;

export const create: PartModelFactory = createDiodeModel({ ...SIGNAL_DIODE, what: "1N4148 signal diode" });
